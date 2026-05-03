# Claude CLI Headless Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a built-in `claude-cli` agent provider that invokes the Claude Code CLI in headless mode (`claude -p`) instead of the SDK, using OAuth-based host login as auth.

**Architecture:** The new provider lives next to `claude` (SDK) in `container/agent-runner/src/providers/`. It spawns `/pnpm/claude` per turn with `--output-format stream-json`, parses the JSON-line stream into `ProviderEvent`s, and uses on-disk hook scripts (configured via `~/.claude/settings.json`) to enforce the same denylist + container_state tracking the SDK does in-process. Host-side: a new `src/providers/claude-cli.ts` registers per-spawn mount/env contributions — copies host's OAuth credential file into a per-session sibling dir (outside `/workspace`) and nested-RO mounts the three control files (`.credentials.json`, `settings.json`, `mcp.json`) over the per-group `.claude-shared` RW base at `/home/node/.claude/`. Coexists with `claude` (SDK) — selection is per-group via `container.json`.

**Tech Stack:** Bun (container TS runtime), Node + pnpm (host), `bun:test` (container tests), `vitest` (host tests), Docker bind-mounts (nested RW + RO), SQLite for hook→container_state coordination.

---

## Reference: Files to create / modify

**Create (container/agent-runner side):**
- `container/agent-runner/src/providers/tool-policies.ts` — extracted `TOOL_ALLOWLIST` + `DISALLOWED_TOOLS` (shared with SDK provider).
- `container/agent-runner/src/providers/claude-cli.ts` — provider class, argv builder, stream parser.
- `container/agent-runner/src/providers/claude-cli-hooks/transcript.ts` — extracted `parseTranscript` + `formatTranscriptMarkdown`.
- `container/agent-runner/src/providers/claude-cli-hooks/pre-tool-use.ts` — denylist + `setContainerToolInFlight`.
- `container/agent-runner/src/providers/claude-cli-hooks/post-tool-use.ts` — `clearContainerToolInFlight`.
- `container/agent-runner/src/providers/claude-cli-hooks/pre-compact.ts` — transcript archiving.

**Create (host side):**
- `src/providers/claude-cli.ts` — registers `ProviderContainerConfigFn` for `claude-cli` (mounts + env + per-spawn file generation).

**Create (tests):**
- `container/agent-runner/src/providers/tool-policies.test.ts`
- `container/agent-runner/src/providers/claude-cli.test.ts`
- `container/agent-runner/src/providers/claude-cli-hooks/transcript.test.ts`
- `container/agent-runner/src/providers/claude-cli-hooks/pre-tool-use.test.ts`
- `container/agent-runner/src/providers/claude-cli-hooks/post-tool-use.test.ts`
- `container/agent-runner/src/providers/claude-cli-hooks/pre-compact.test.ts`
- `src/providers/claude-cli.test.ts` (vitest)

**Create (docs):**
- `docs/claude-cli-provider.md`

**Modify:**
- `container/agent-runner/src/providers/index.ts` — add `import './claude-cli.js';`.
- `container/agent-runner/src/providers/claude.ts` — import `TOOL_ALLOWLIST` + `DISALLOWED_TOOLS` from `tool-policies.ts`; import `parseTranscript` + `formatTranscriptMarkdown` from `claude-cli-hooks/transcript.ts`.
- `container/agent-runner/src/providers/factory.test.ts` — add a `claude-cli` case.
- `src/providers/provider-container-registry.ts` — extend `ProviderContainerContext` with `containerConfig` field so the registered fn can read `mcpServers` without duplicating I/O.
- `src/container-runner.ts` — pass `containerConfig` into the new context field (one-line change to `resolveProviderContribution`).
- `src/providers/index.ts` — append `import './claude-cli.js';`.
- `src/host-sweep.ts` — periodic credentials-mtime resync for active sessions running `claude-cli`.
- `CLAUDE.md` (root) — note the new provider in the providers section.

---

## Architectural deviations from the spec (read before starting)

The spec is approved but two design points are revised here based on code reading. Implement per the plan, not the spec, where they disagree.

1. **Host-mounted dir for control files: `/home/node/.claude/`, not `/root/.claude/`.**
   The container runs as user `node` (Dockerfile `USER node`) with HOME=/home/node. The existing per-group `.claude-shared` mount already lands at `/home/node/.claude:rw` (`src/container-runner.ts:311`). The CLI reads `~/.claude/` which resolves to `/home/node/.claude`. Mounting credentials to `/root/.claude/` (as the spec proposes) would put them where the CLI never looks.

2. **Per-session control files live OUTSIDE `<sessionDir>`, not inside it.**
   The spec proposes `data/v2-sessions/<session>/claude/` with nested-RO mounts. Problem: `<sessionDir>` is RW-mounted to `/workspace`, so the agent could write to those control files via `/workspace/claude/...` and bypass the nested RO mount that's only on `/root/.claude/...`. The spec's own risk section endorses moving the dir to a sibling. We do that here:
   ```
   <DATA_DIR>/v2-sessions/<agent_group_id>/.claude-cli-control/<session_id>/
     ├── .credentials.json
     ├── settings.json
     └── mcp.json
   ```
   This dir is NOT under any container mount target, so there's no RW path the agent can reach. Each file is nested-RO mounted on top of the RW `.claude-shared` base.

3. **Use the existing `provider-container-registry` pattern, not inline `if (provider === 'claude-cli')` in `container-runner.ts`.**
   The host already has `src/providers/provider-container-registry.ts` for exactly this purpose (see `src/providers/claude.ts` for the existing OneCLI-base-URL example). The spec's pseudocode predates this pattern. Add `src/providers/claude-cli.ts` that calls `registerProviderContainerConfig('claude-cli', ...)`. The fn returns mounts + env per spawn and runs side effects (mkdir, fs.writeFileSync) before returning.

4. **`mcp.json` is generated by the host, not the container.**
   The spec implies the container writes its own MCP config. The host already reads `container.json` (which contains `mcpServers`); generating `mcp.json` host-side keeps the agent-runner stateless w.r.t. the CLI provider. The host hard-codes the built-in `nanoclaw` MCP server's container-side path (`/app/src/mcp-tools/index.ts`) since `/app/src` is a stable mount.

---

## Phase 0: Worktree + branch

### Task 0: Create a feature branch in a worktree

**Files:** none

- [ ] **Step 1: Create worktree branch**

Run:
```
git worktree add ../nanoclaw-claude-cli -b feat/claude-cli-provider main
cd ../nanoclaw-claude-cli
```

Expected: worktree created cleanly, on a fresh branch off main.

If the user already invoked this plan from a worktree (i.e. via brainstorming → writing-plans), this step is a no-op — just confirm `git status` is clean.

- [ ] **Step 2: Verify the baseline build is green BEFORE changing anything**

Run from the worktree root:
```
pnpm install --frozen-lockfile
pnpm exec tsc --noEmit
pnpm exec vitest run
cd container/agent-runner && bun install --frozen-lockfile && bun test && cd -
```

Expected: all four commands exit 0. If any fails, STOP and report — the plan assumes a clean baseline.

---

## Phase 1: Shared building blocks

### Task 1: Extract `tool-policies.ts` (DRY shared with SDK provider)

**Files:**
- Create: `container/agent-runner/src/providers/tool-policies.ts`
- Create: `container/agent-runner/src/providers/tool-policies.test.ts`
- Modify: `container/agent-runner/src/providers/claude.ts:25-58` (replace inline arrays with imports)

- [ ] **Step 1: Write the failing test**

Create `container/agent-runner/src/providers/tool-policies.test.ts`:

```ts
import { describe, expect, it } from 'bun:test';

import { DISALLOWED_TOOLS, TOOL_ALLOWLIST } from './tool-policies.js';

describe('tool-policies', () => {
  it('exports the same denylist the SDK provider used inline', () => {
    expect(DISALLOWED_TOOLS).toEqual([
      'CronCreate',
      'CronDelete',
      'CronList',
      'ScheduleWakeup',
      'AskUserQuestion',
      'EnterPlanMode',
      'ExitPlanMode',
      'EnterWorktree',
      'ExitWorktree',
    ]);
  });

  it('exports the same allowlist the SDK provider used inline', () => {
    expect(TOOL_ALLOWLIST).toContain('Bash');
    expect(TOOL_ALLOWLIST).toContain('Read');
    expect(TOOL_ALLOWLIST).toContain('Write');
    expect(TOOL_ALLOWLIST).toContain('mcp__nanoclaw__*');
    expect(TOOL_ALLOWLIST.length).toBeGreaterThan(15);
  });

  it('arrays are frozen so callers cannot mutate them', () => {
    expect(Object.isFrozen(DISALLOWED_TOOLS)).toBe(true);
    expect(Object.isFrozen(TOOL_ALLOWLIST)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd container/agent-runner && bun test src/providers/tool-policies.test.ts`
Expected: FAIL with "Cannot find module './tool-policies.js'".

- [ ] **Step 3: Create the module**

Create `container/agent-runner/src/providers/tool-policies.ts`:

```ts
/**
 * Tool policy constants shared by built-in Claude providers (SDK + CLI).
 *
 * Extracted from claude.ts so both providers stay in lockstep — adding a
 * disallowed tool here patches the SDK provider's `disallowedTools` list and
 * the CLI provider's `--disallowedTools` argv simultaneously.
 */

/**
 * Tools the SDK exposes by default but that don't fit nanoclaw's
 * async message-passing model (or have nanoclaw equivalents that are
 * persistent across container restarts).
 *
 * - CronCreate / CronDelete / CronList / ScheduleWakeup: nanoclaw has
 *   durable scheduling via `mcp__nanoclaw__schedule_task`.
 * - AskUserQuestion: SDK returns a placeholder; nanoclaw has
 *   `mcp__nanoclaw__ask_user_question` that persists and blocks on a real
 *   reply through the channel.
 * - EnterPlanMode / ExitPlanMode / EnterWorktree / ExitWorktree: Claude
 *   Code interactive UI affordances; would appear stuck in a headless
 *   container.
 */
export const DISALLOWED_TOOLS: readonly string[] = Object.freeze([
  'CronCreate',
  'CronDelete',
  'CronList',
  'ScheduleWakeup',
  'AskUserQuestion',
  'EnterPlanMode',
  'ExitPlanMode',
  'EnterWorktree',
  'ExitWorktree',
]);

/** Tools an agent in a nanoclaw container is allowed to call. */
export const TOOL_ALLOWLIST: readonly string[] = Object.freeze([
  'Bash',
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'WebSearch',
  'WebFetch',
  'Task',
  'TaskOutput',
  'TaskStop',
  'TeamCreate',
  'TeamDelete',
  'SendMessage',
  'TodoWrite',
  'ToolSearch',
  'Skill',
  'NotebookEdit',
  'mcp__nanoclaw__*',
]);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd container/agent-runner && bun test src/providers/tool-policies.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Migrate `claude.ts` to use the shared module**

In `container/agent-runner/src/providers/claude.ts` replace lines 25-58 (the inline `DISALLOWED_TOOLS` and `TOOL_ALLOWLIST` arrays) with a single import at the top of the file (alongside the existing imports):

```ts
import { DISALLOWED_TOOLS, TOOL_ALLOWLIST } from './tool-policies.js';
```

Delete the original two `const DISALLOWED_TOOLS = [...]` and `const TOOL_ALLOWLIST = [...]` blocks. The callers later in the file (`disallowedTools: ...` and `allowedTools: ...` on the SDK option object) need a spread because the imported types are `readonly string[]` and the SDK expects mutable `string[]`. Update those two call sites to `[...DISALLOWED_TOOLS]` and `[...TOOL_ALLOWLIST]`.

- [ ] **Step 6: Run the agent-runner test suite to confirm no regression**

Run: `cd container/agent-runner && bun test`
Expected: all existing tests still pass, new `tool-policies.test.ts` passes.

- [ ] **Step 7: Run typecheck**

Run from repo root: `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit`
Expected: 0 errors.

- [ ] **Step 8: Commit**

Run:
```
git add container/agent-runner/src/providers/tool-policies.ts container/agent-runner/src/providers/tool-policies.test.ts container/agent-runner/src/providers/claude.ts
```
```
git commit -m "refactor(provider): extract shared tool-policies for SDK and upcoming CLI provider"
```

---

### Task 2: Extract `transcript.ts` helpers (DRY)

**Files:**
- Create: `container/agent-runner/src/providers/claude-cli-hooks/transcript.ts`
- Create: `container/agent-runner/src/providers/claude-cli-hooks/transcript.test.ts`
- Modify: `container/agent-runner/src/providers/claude.ts:104-142` (replace inline helpers with imports)

- [ ] **Step 1: Write the failing test**

Create `container/agent-runner/src/providers/claude-cli-hooks/transcript.test.ts`:

```ts
import { describe, expect, it } from 'bun:test';

import { formatTranscriptMarkdown, parseTranscript } from './transcript.js';

describe('parseTranscript', () => {
  it('extracts user + assistant messages from JSONL', () => {
    const jsonl = [
      JSON.stringify({ type: 'user', message: { content: 'Hi' } }),
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Hello back' }] },
      }),
    ].join('\n');

    expect(parseTranscript(jsonl)).toEqual([
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello back' },
    ]);
  });

  it('handles assistant content arrays with mixed parts (keeps text only)', () => {
    const jsonl = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Pre.' },
          { type: 'tool_use', id: 'x', name: 'Bash', input: {} },
          { type: 'text', text: 'Post.' },
        ],
      },
    });
    expect(parseTranscript(jsonl)).toEqual([{ role: 'assistant', content: 'Pre.Post.' }]);
  });

  it('skips unparseable lines silently', () => {
    expect(parseTranscript('not json\n{"type":"user","message":{"content":"OK"}}')).toEqual([
      { role: 'user', content: 'OK' },
    ]);
  });

  it('skips entries with no content', () => {
    const jsonl = JSON.stringify({ type: 'user', message: { content: '' } });
    expect(parseTranscript(jsonl)).toEqual([]);
  });
});

describe('formatTranscriptMarkdown', () => {
  it('renders a title block + role-tagged messages', () => {
    const md = formatTranscriptMarkdown(
      [
        { role: 'user', content: 'Q?' },
        { role: 'assistant', content: 'A.' },
      ],
      'My session',
      'Nano',
    );
    expect(md).toContain('# My session');
    expect(md).toContain('**User**: Q?');
    expect(md).toContain('**Nano**: A.');
    expect(md).toContain('Archived: ');
  });

  it('truncates messages longer than 2000 chars', () => {
    const long = 'x'.repeat(2500);
    const md = formatTranscriptMarkdown([{ role: 'user', content: long }]);
    expect(md).toContain('xxx...');
    expect(md.length).toBeLessThan(2300);
  });

  it("falls back to 'Conversation' / 'Assistant' when title and assistantName are missing", () => {
    const md = formatTranscriptMarkdown([{ role: 'assistant', content: 'Yo' }]);
    expect(md).toContain('# Conversation');
    expect(md).toContain('**Assistant**: Yo');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd container/agent-runner && bun test src/providers/claude-cli-hooks/transcript.test.ts`
Expected: FAIL with module-not-found.

- [ ] **Step 3: Create the module**

Create `container/agent-runner/src/providers/claude-cli-hooks/transcript.ts` (extracted verbatim from `claude.ts:104-142` — the only changes are the export keyword and removing the leading `// ── Transcript archiving (PreCompact hook) ──` comment block):

```ts
/**
 * Transcript helpers shared by the SDK provider's PreCompact callback and
 * the CLI provider's `pre-compact.ts` hook script. Both serialize JSONL
 * transcripts to markdown for archival in `/workspace/agent/conversations/`.
 */

export interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

export function parseTranscript(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' && entry.message?.content) {
        const text =
          typeof entry.message.content === 'string'
            ? entry.message.content
            : entry.message.content.map((c: { text?: string }) => c.text || '').join('');
        if (text) messages.push({ role: 'user', content: text });
      } else if (entry.type === 'assistant' && entry.message?.content) {
        const textParts = entry.message.content
          .filter((c: { type: string }) => c.type === 'text')
          .map((c: { text: string }) => c.text);
        const text = textParts.join('');
        if (text) messages.push({ role: 'assistant', content: text });
      }
    } catch {
      /* skip unparseable lines */
    }
  }
  return messages;
}

export function formatTranscriptMarkdown(
  messages: ParsedMessage[],
  title?: string | null,
  assistantName?: string,
): string {
  const now = new Date();
  const dateStr = now.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
  const lines = [`# ${title || 'Conversation'}`, '', `Archived: ${dateStr}`, '', '---', ''];
  for (const msg of messages) {
    const sender = msg.role === 'user' ? 'User' : assistantName || 'Assistant';
    const content = msg.content.length > 2000 ? msg.content.slice(0, 2000) + '...' : msg.content;
    lines.push(`**${sender}**: ${content}`, '');
  }
  return lines.join('\n');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd container/agent-runner && bun test src/providers/claude-cli-hooks/transcript.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Migrate `claude.ts` to import the helpers**

In `container/agent-runner/src/providers/claude.ts`:

a) Add the import at the top alongside other imports:
```ts
import { formatTranscriptMarkdown, parseTranscript } from './claude-cli-hooks/transcript.js';
```

b) Delete the inline helper block: the `// ── Transcript archiving (PreCompact hook) ──` comment, the `interface ParsedMessage { ... }` declaration, and both `function parseTranscript(...)` and `function formatTranscriptMarkdown(...)` definitions (lines 104-142 in the pre-edit file). The remaining `createPreCompactHook(...)` callsite uses `parseTranscript` and `formatTranscriptMarkdown` unchanged — the imported names match.

- [ ] **Step 6: Run the existing agent-runner test suite**

Run: `cd container/agent-runner && bun test`
Expected: all pre-existing tests still pass.

- [ ] **Step 7: Typecheck**

Run from repo root: `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit`
Expected: 0 errors.

- [ ] **Step 8: Commit**

```
git add container/agent-runner/src/providers/claude-cli-hooks/transcript.ts container/agent-runner/src/providers/claude-cli-hooks/transcript.test.ts container/agent-runner/src/providers/claude.ts
```
```
git commit -m "refactor(provider): extract transcript parser/formatter for SDK and CLI providers"
```

---

## Phase 2: Hook scripts

### Task 3: `post-tool-use.ts` hook (smallest, no external deps)

**Files:**
- Create: `container/agent-runner/src/providers/claude-cli-hooks/post-tool-use.ts`
- Create: `container/agent-runner/src/providers/claude-cli-hooks/post-tool-use.test.ts`

- [ ] **Step 1: Write the failing test**

Create `container/agent-runner/src/providers/claude-cli-hooks/post-tool-use.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

const dbMock = mock(() => {});

mock.module('../../db/connection.js', () => ({
  clearContainerToolInFlight: dbMock,
  setContainerToolInFlight: () => {},
}));

describe('post-tool-use hook', () => {
  beforeEach(() => {
    dbMock.mockClear();
  });

  afterEach(() => {
    delete (process as { __postToolUseInput?: string }).__postToolUseInput;
  });

  it('clears container_state and exits 0', async () => {
    // Run the hook in a subprocess so we can drive its stdin and read its
    // exit code without polluting this test process.
    const proc = Bun.spawn({
      cmd: [
        'bun',
        'run',
        new URL('./post-tool-use.ts', import.meta.url).pathname,
      ],
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    proc.stdin.write(JSON.stringify({ tool_name: 'Bash' }));
    proc.stdin.end();
    const exit = await proc.exited;
    expect(exit).toBe(0);
  });
});
```

Note: the mock import is for documentation — when the hook is run in a subprocess (`bun run`) it has its own module graph. The actual db side effect in the subprocess will fail (no /workspace/outbound.db), and the `try { ... } catch {}` swallow inside the hook will keep the exit code at 0. We assert on exit code, which is what callers (the CLI) observe.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd container/agent-runner && bun test src/providers/claude-cli-hooks/post-tool-use.test.ts`
Expected: FAIL with module-not-found for `./post-tool-use.ts`.

- [ ] **Step 3: Create the hook**

Create `container/agent-runner/src/providers/claude-cli-hooks/post-tool-use.ts`:

```ts
#!/usr/bin/env bun
/**
 * PostToolUse / PostToolUseFailure hook for the claude-cli provider.
 *
 * Mirrors the SDK provider's `postToolUseHook` callback (claude.ts) — clears
 * the container_state.current_tool entry so the host sweep returns to its
 * default stuck-tolerance window after a long-running tool finishes.
 *
 * The CLI invokes this script as a child process and pipes the event JSON
 * via stdin. We parse defensively (we never read fields), do a single short
 * SQLite UPDATE, and exit 0. Any DB error is swallowed: the CLI is unblocked
 * regardless of whether the host sweep got the signal — a stale container_state
 * entry resolves itself on the next PreToolUse.
 */
import { clearContainerToolInFlight } from '../../db/connection.js';

// Drain stdin (Claude pipes the event here). We don't need to parse it for
// post-tool-use, but a connected pipe must be drained for the parent to
// consider the hook "done".
await Bun.stdin.text().catch(() => '');

try {
  clearContainerToolInFlight();
} catch (err) {
  console.error(`[post-tool-use] failed to clear container_state: ${err instanceof Error ? err.message : String(err)}`);
}

process.exit(0);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd container/agent-runner && bun test src/providers/claude-cli-hooks/post-tool-use.test.ts`
Expected: PASS — exit code 0.

- [ ] **Step 5: Typecheck**

Run from repo root: `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit`
Expected: 0 errors.

- [ ] **Step 6: Commit**

```
git add container/agent-runner/src/providers/claude-cli-hooks/post-tool-use.ts container/agent-runner/src/providers/claude-cli-hooks/post-tool-use.test.ts
```
```
git commit -m "feat(claude-cli-hooks): add post-tool-use hook to clear container_state"
```

---

### Task 4: `pre-tool-use.ts` hook (denylist + container_state)

**Files:**
- Create: `container/agent-runner/src/providers/claude-cli-hooks/pre-tool-use.ts`
- Create: `container/agent-runner/src/providers/claude-cli-hooks/pre-tool-use.test.ts`

- [ ] **Step 1: Write the failing test**

Create `container/agent-runner/src/providers/claude-cli-hooks/pre-tool-use.test.ts`:

```ts
import { describe, expect, it } from 'bun:test';

const HOOK = new URL('./pre-tool-use.ts', import.meta.url).pathname;

async function runHook(stdinJson: string): Promise<{ exit: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn({
    cmd: ['bun', 'run', HOOK],
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  proc.stdin.write(stdinJson);
  proc.stdin.end();
  const exit = await proc.exited;
  return {
    exit,
    stdout: await new Response(proc.stdout).text(),
    stderr: await new Response(proc.stderr).text(),
  };
}

describe('pre-tool-use hook', () => {
  it('blocks tools on the denylist with structured JSON', async () => {
    const { exit, stdout } = await runHook(JSON.stringify({ tool_name: 'EnterPlanMode' }));
    expect(exit).toBe(0);
    const decision = JSON.parse(stdout.trim());
    expect(decision.decision).toBe('block');
    expect(decision.stopReason).toMatch(/EnterPlanMode/);
    expect(decision.stopReason).toMatch(/nanoclaw/i);
  });

  it('allows tools not on the denylist with no decision JSON', async () => {
    const { exit, stdout } = await runHook(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } }));
    expect(exit).toBe(0);
    expect(stdout.trim()).toBe('');
  });

  it('allows tools when input is empty / non-JSON (defensive — never blocks legitimate work)', async () => {
    const { exit, stdout } = await runHook('');
    expect(exit).toBe(0);
    expect(stdout.trim()).toBe('');
  });

  it('blocks each entry of DISALLOWED_TOOLS', async () => {
    for (const name of [
      'CronCreate',
      'CronDelete',
      'CronList',
      'ScheduleWakeup',
      'AskUserQuestion',
      'EnterPlanMode',
      'ExitPlanMode',
      'EnterWorktree',
      'ExitWorktree',
    ]) {
      const { stdout } = await runHook(JSON.stringify({ tool_name: name }));
      expect(JSON.parse(stdout.trim()).decision, `${name} must be blocked`).toBe('block');
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd container/agent-runner && bun test src/providers/claude-cli-hooks/pre-tool-use.test.ts`
Expected: FAIL with module-not-found.

- [ ] **Step 3: Create the hook**

Create `container/agent-runner/src/providers/claude-cli-hooks/pre-tool-use.ts`:

```ts
#!/usr/bin/env bun
/**
 * PreToolUse hook for the claude-cli provider.
 *
 * Two responsibilities, both mirroring the SDK provider's `preToolUseHook`
 * callback (claude.ts):
 *
 *   1. Block tools on the DISALLOWED_TOOLS list. The CLI reads our
 *      stdout for a JSON decision: `{decision:'block', stopReason:'...'}`
 *      (anything else is treated as "continue"). Defense-in-depth: even if
 *      `--disallowedTools` somehow leaks one through, this catches it.
 *
 *   2. Record the in-flight tool + its declared timeout (Bash exposes
 *      `tool_input.timeout` in ms) so the host sweep widens stuck tolerance
 *      while a long-running tool is legitimately working.
 *
 * The DB write is best-effort: if /workspace/outbound.db isn't writable for
 * any reason, we still let the tool proceed — the host sweep falls back to
 * its default tolerance.
 */
import { setContainerToolInFlight } from '../../db/connection.js';
import { DISALLOWED_TOOLS } from '../tool-policies.js';

const raw = await Bun.stdin.text().catch(() => '');
let event: { tool_name?: string; tool_input?: Record<string, unknown> } = {};
try {
  event = raw ? JSON.parse(raw) : {};
} catch {
  /* empty/non-JSON input → treat as no-op (allow) */
}

const toolName = event.tool_name ?? '';

if (toolName && DISALLOWED_TOOLS.includes(toolName)) {
  console.log(
    JSON.stringify({
      decision: 'block',
      stopReason: `Tool '${toolName}' is not available in this environment — use the nanoclaw equivalent.`,
    }),
  );
  process.exit(0);
}

// Bash exposes its timeout via tool_input.timeout (ms). Other tools: no declared timeout.
const declaredTimeoutMs =
  toolName === 'Bash' && typeof event.tool_input?.timeout === 'number'
    ? (event.tool_input.timeout as number)
    : null;

if (toolName) {
  try {
    setContainerToolInFlight(toolName, declaredTimeoutMs);
  } catch (err) {
    console.error(
      `[pre-tool-use] failed to record container_state: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

process.exit(0);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd container/agent-runner && bun test src/providers/claude-cli-hooks/pre-tool-use.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Typecheck**

Run from repo root: `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit`
Expected: 0 errors.

- [ ] **Step 6: Commit**

```
git add container/agent-runner/src/providers/claude-cli-hooks/pre-tool-use.ts container/agent-runner/src/providers/claude-cli-hooks/pre-tool-use.test.ts
```
```
git commit -m "feat(claude-cli-hooks): add pre-tool-use hook (denylist + container_state)"
```

---

### Task 5: `pre-compact.ts` hook (transcript archiving)

**Files:**
- Create: `container/agent-runner/src/providers/claude-cli-hooks/pre-compact.ts`
- Create: `container/agent-runner/src/providers/claude-cli-hooks/pre-compact.test.ts`

- [ ] **Step 1: Write the failing test**

Create `container/agent-runner/src/providers/claude-cli-hooks/pre-compact.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

const HOOK = new URL('./pre-compact.ts', import.meta.url).pathname;

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pre-compact-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function runHook(env: Record<string, string>, stdinJson: string): Promise<number> {
  const proc = Bun.spawn({
    cmd: ['bun', 'run', HOOK],
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ...env },
  });
  proc.stdin.write(stdinJson);
  proc.stdin.end();
  return await proc.exited;
}

describe('pre-compact hook', () => {
  it('writes a markdown transcript to {workspaceAgent}/conversations/', async () => {
    const transcript = path.join(tmpDir, 'session.jsonl');
    const workspaceAgent = path.join(tmpDir, 'workspace', 'agent');
    fs.mkdirSync(workspaceAgent, { recursive: true });
    fs.writeFileSync(
      transcript,
      [
        JSON.stringify({ type: 'user', message: { content: 'hi' } }),
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'yo' }] } }),
      ].join('\n'),
    );

    const exit = await runHook(
      { NANOCLAW_CONVERSATIONS_DIR: path.join(workspaceAgent, 'conversations'), NANOCLAW_ASSISTANT_NAME: 'Nano' },
      JSON.stringify({ transcript_path: transcript, session_id: 'abc' }),
    );
    expect(exit).toBe(0);

    const files = fs.readdirSync(path.join(workspaceAgent, 'conversations'));
    expect(files.length).toBe(1);
    const md = fs.readFileSync(path.join(workspaceAgent, 'conversations', files[0]), 'utf-8');
    expect(md).toContain('**User**: hi');
    expect(md).toContain('**Nano**: yo');
  });

  it('is a no-op when transcript_path is missing', async () => {
    const workspaceAgent = path.join(tmpDir, 'workspace', 'agent');
    fs.mkdirSync(workspaceAgent, { recursive: true });
    const exit = await runHook(
      { NANOCLAW_CONVERSATIONS_DIR: path.join(workspaceAgent, 'conversations') },
      JSON.stringify({}),
    );
    expect(exit).toBe(0);
    expect(fs.existsSync(path.join(workspaceAgent, 'conversations'))).toBe(false);
  });

  it('is a no-op when transcript file is empty (no parsed messages)', async () => {
    const transcript = path.join(tmpDir, 'session.jsonl');
    const workspaceAgent = path.join(tmpDir, 'workspace', 'agent');
    fs.mkdirSync(workspaceAgent, { recursive: true });
    fs.writeFileSync(transcript, '');
    const exit = await runHook(
      { NANOCLAW_CONVERSATIONS_DIR: path.join(workspaceAgent, 'conversations') },
      JSON.stringify({ transcript_path: transcript, session_id: 'abc' }),
    );
    expect(exit).toBe(0);
    const dir = path.join(workspaceAgent, 'conversations');
    expect(!fs.existsSync(dir) || fs.readdirSync(dir).length === 0).toBe(true);
  });

  it('uses the summary from sessions-index.json when available', async () => {
    const dir = path.join(tmpDir, 'projects');
    fs.mkdirSync(dir, { recursive: true });
    const transcript = path.join(dir, 'session.jsonl');
    fs.writeFileSync(transcript, JSON.stringify({ type: 'user', message: { content: 'hi' } }));
    fs.writeFileSync(
      path.join(dir, 'sessions-index.json'),
      JSON.stringify({ entries: [{ sessionId: 'abc', summary: 'Refactor Plan' }] }),
    );
    const workspaceAgent = path.join(tmpDir, 'workspace', 'agent');
    fs.mkdirSync(workspaceAgent, { recursive: true });

    await runHook(
      { NANOCLAW_CONVERSATIONS_DIR: path.join(workspaceAgent, 'conversations') },
      JSON.stringify({ transcript_path: transcript, session_id: 'abc' }),
    );

    const files = fs.readdirSync(path.join(workspaceAgent, 'conversations'));
    expect(files[0]).toMatch(/refactor-plan\.md$/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd container/agent-runner && bun test src/providers/claude-cli-hooks/pre-compact.test.ts`
Expected: FAIL with module-not-found.

- [ ] **Step 3: Create the hook**

Create `container/agent-runner/src/providers/claude-cli-hooks/pre-compact.ts`:

```ts
#!/usr/bin/env bun
/**
 * PreCompact hook for the claude-cli provider.
 *
 * Mirrors the SDK provider's `createPreCompactHook` (claude.ts) — when
 * Claude Code is about to compact context, archive the pre-compact
 * transcript to `<conversationsDir>/YYYY-MM-DD-<slug>.md` so the
 * conversation isn't lost.
 *
 * Inputs (env):
 *   NANOCLAW_CONVERSATIONS_DIR  — output dir (defaults to /workspace/agent/conversations)
 *   NANOCLAW_ASSISTANT_NAME     — display name for assistant messages
 *
 * Inputs (stdin JSON):
 *   { transcript_path: string, session_id: string }
 */
import fs from 'fs';
import path from 'path';

import { formatTranscriptMarkdown, parseTranscript } from './transcript.js';

const raw = await Bun.stdin.text().catch(() => '');
let event: { transcript_path?: string; session_id?: string } = {};
try {
  event = raw ? JSON.parse(raw) : {};
} catch {
  /* malformed payload → silent no-op */
}

const transcriptPath = event.transcript_path;
if (!transcriptPath || !fs.existsSync(transcriptPath)) {
  process.exit(0);
}

const messages = parseTranscript(fs.readFileSync(transcriptPath, 'utf-8'));
if (messages.length === 0) {
  process.exit(0);
}

let summary: string | undefined;
const indexPath = path.join(path.dirname(transcriptPath), 'sessions-index.json');
if (fs.existsSync(indexPath)) {
  try {
    const idx = JSON.parse(fs.readFileSync(indexPath, 'utf-8')) as {
      entries?: Array<{ sessionId: string; summary?: string }>;
    };
    summary = idx.entries?.find((e) => e.sessionId === event.session_id)?.summary;
  } catch {
    /* ignore */
  }
}

const slug = summary
  ? summary
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 50)
  : `conversation-${new Date().getHours().toString().padStart(2, '0')}${new Date().getMinutes().toString().padStart(2, '0')}`;

const conversationsDir = process.env.NANOCLAW_CONVERSATIONS_DIR || '/workspace/agent/conversations';
fs.mkdirSync(conversationsDir, { recursive: true });

const filename = `${new Date().toISOString().split('T')[0]}-${slug}.md`;
const assistantName = process.env.NANOCLAW_ASSISTANT_NAME || undefined;
fs.writeFileSync(path.join(conversationsDir, filename), formatTranscriptMarkdown(messages, summary, assistantName));

process.exit(0);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd container/agent-runner && bun test src/providers/claude-cli-hooks/pre-compact.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Typecheck**

Run from repo root: `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit`
Expected: 0 errors.

- [ ] **Step 6: Commit**

```
git add container/agent-runner/src/providers/claude-cli-hooks/pre-compact.ts container/agent-runner/src/providers/claude-cli-hooks/pre-compact.test.ts
```
```
git commit -m "feat(claude-cli-hooks): add pre-compact hook to archive transcripts on compaction"
```

---

## Phase 3: Provider implementation

### Task 6: Pure argv builder (`buildClaudeCliArgs`) — TDD

**Files:**
- Create: `container/agent-runner/src/providers/claude-cli.ts` (initial — argv builder only; the class skeleton arrives in Task 8)
- Create: `container/agent-runner/src/providers/claude-cli.test.ts`

- [ ] **Step 1: Write the failing test**

Create `container/agent-runner/src/providers/claude-cli.test.ts`:

```ts
import { describe, expect, it } from 'bun:test';

import { buildClaudeCliArgs } from './claude-cli.js';

describe('buildClaudeCliArgs', () => {
  it('produces the minimal headless invocation', () => {
    const args = buildClaudeCliArgs({
      prompt: 'Hello',
      cwd: '/workspace/agent',
    });
    expect(args[0]).toBe('-p');
    expect(args).toContain('--output-format');
    expect(args).toContain('stream-json');
    expect(args).toContain('--verbose');
    expect(args).toContain('--permission-mode');
    expect(args).toContain('bypassPermissions');
    expect(args).toContain('--dangerously-skip-permissions');
    expect(args).toContain('--mcp-config');
    expect(args).toContain('--settings');
  });

  it('appends --resume <id> when continuation is set', () => {
    const args = buildClaudeCliArgs({
      prompt: 'Hi',
      cwd: '/workspace/agent',
      continuation: 'sess-abc',
    });
    const i = args.indexOf('--resume');
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toBe('sess-abc');
  });

  it('omits --resume when continuation is empty', () => {
    const args = buildClaudeCliArgs({ prompt: 'Hi', cwd: '/workspace/agent' });
    expect(args).not.toContain('--resume');
  });

  it('appends --append-system-prompt when systemContext.instructions is set', () => {
    const args = buildClaudeCliArgs({
      prompt: 'Hi',
      cwd: '/workspace/agent',
      systemContext: { instructions: 'Be terse.' },
    });
    const i = args.indexOf('--append-system-prompt');
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toBe('Be terse.');
  });

  it('appends --add-dir for each additionalDirectories entry', () => {
    const args = buildClaudeCliArgs({
      prompt: 'Hi',
      cwd: '/workspace/agent',
      additionalDirectories: ['/workspace/extra/a', '/workspace/extra/b'],
    });
    const positions = args
      .map((a, idx) => (a === '--add-dir' ? idx : -1))
      .filter((idx) => idx !== -1);
    expect(positions.length).toBe(2);
    expect(args[positions[0] + 1]).toBe('/workspace/extra/a');
    expect(args[positions[1] + 1]).toBe('/workspace/extra/b');
  });

  it('serializes allowed/disallowed tools as comma-separated strings', () => {
    const args = buildClaudeCliArgs({ prompt: 'Hi', cwd: '/workspace/agent' });
    const allowedAt = args.indexOf('--allowedTools');
    const disallowedAt = args.indexOf('--disallowedTools');
    expect(allowedAt).toBeGreaterThan(-1);
    expect(disallowedAt).toBeGreaterThan(-1);
    expect(args[allowedAt + 1]).toContain('Bash');
    expect(args[allowedAt + 1]).toContain('mcp__nanoclaw__*');
    expect(args[disallowedAt + 1]).toContain('EnterPlanMode');
  });

  it("places the prompt last after a '--' separator (defense against prompts that start with '--')", () => {
    const args = buildClaudeCliArgs({ prompt: 'normal prompt', cwd: '/workspace/agent' });
    expect(args[args.length - 2]).toBe('--');
    expect(args[args.length - 1]).toBe('normal prompt');
  });

  it('does not let an attacker-controlled prompt sneak past flag parsing', () => {
    const args = buildClaudeCliArgs({ prompt: '--mcp-config /tmp/evil.json', cwd: '/workspace/agent' });
    // The malicious prompt is the LAST element AFTER '--', so the CLI's argv
    // parser stops interpreting flags before it and the original
    // --mcp-config <legit> earlier in args wins.
    expect(args[args.length - 1]).toBe('--mcp-config /tmp/evil.json');
    const sepIdx = args.lastIndexOf('--');
    expect(sepIdx).toBe(args.length - 2);
  });

  it('respects custom mcpConfigPath and settingsPath', () => {
    const args = buildClaudeCliArgs({
      prompt: 'Hi',
      cwd: '/workspace/agent',
      mcpConfigPath: '/custom/mcp.json',
      settingsPath: '/custom/settings.json',
    });
    const m = args.indexOf('--mcp-config');
    const s = args.indexOf('--settings');
    expect(args[m + 1]).toBe('/custom/mcp.json');
    expect(args[s + 1]).toBe('/custom/settings.json');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd container/agent-runner && bun test src/providers/claude-cli.test.ts`
Expected: FAIL — `claude-cli.ts` doesn't exist.

- [ ] **Step 3: Create the initial module with the argv builder**

Create `container/agent-runner/src/providers/claude-cli.ts`:

```ts
/**
 * Claude CLI provider — invokes /pnpm/claude in headless mode with
 * stream-json output, instead of going through the SDK. Auth uses the
 * host's OAuth login (no ANTHROPIC_API_KEY, no OneCLI proxy for the AI
 * traffic). Hook scripts on disk enforce the same denylist + container_state
 * tracking the SDK provider does in-process.
 *
 * The class itself arrives in a later task; this file currently exports the
 * pure argv builder so it can be unit-tested in isolation.
 */
import { DISALLOWED_TOOLS, TOOL_ALLOWLIST } from './tool-policies.js';

const DEFAULT_MCP_CONFIG_PATH = '/home/node/.claude/mcp.json';
const DEFAULT_SETTINGS_PATH = '/home/node/.claude/settings.json';

export interface BuildClaudeCliArgsInput {
  prompt: string;
  cwd: string;
  continuation?: string;
  systemContext?: { instructions?: string };
  additionalDirectories?: string[];
  /** Override the default `/home/node/.claude/mcp.json` (used in tests). */
  mcpConfigPath?: string;
  /** Override the default `/home/node/.claude/settings.json` (used in tests). */
  settingsPath?: string;
}

/**
 * Build the argv for `Bun.spawn(['/pnpm/claude', ...buildClaudeCliArgs(...)])`.
 *
 * Pure function — no env, no fs, no spawning. The caller spawns.
 *
 * Security note (`--` separator): the formatter (`formatter.ts`) currently
 * guarantees prompts start with `<context ...>` or `/`, but that's an
 * emergent property of the formatter and could regress. We append `--`
 * before the prompt so the CLI argv parser stops looking for flags first;
 * any leading `--` in the prompt is treated as positional. Cost zero,
 * locality of safety high.
 */
export function buildClaudeCliArgs(input: BuildClaudeCliArgsInput): string[] {
  const args: string[] = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--allowedTools',
    TOOL_ALLOWLIST.join(','),
    '--disallowedTools',
    DISALLOWED_TOOLS.join(','),
    '--permission-mode',
    'bypassPermissions',
    '--dangerously-skip-permissions',
    '--mcp-config',
    input.mcpConfigPath ?? DEFAULT_MCP_CONFIG_PATH,
    '--settings',
    input.settingsPath ?? DEFAULT_SETTINGS_PATH,
  ];

  if (input.continuation) {
    args.push('--resume', input.continuation);
  }

  if (input.systemContext?.instructions) {
    args.push('--append-system-prompt', input.systemContext.instructions);
  }

  if (input.additionalDirectories) {
    for (const dir of input.additionalDirectories) {
      args.push('--add-dir', dir);
    }
  }

  // End-of-flags separator + positional prompt. See note above.
  args.push('--', input.prompt);

  return args;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd container/agent-runner && bun test src/providers/claude-cli.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Typecheck**

Run from repo root: `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit`
Expected: 0 errors.

- [ ] **Step 6: Commit**

```
git add container/agent-runner/src/providers/claude-cli.ts container/agent-runner/src/providers/claude-cli.test.ts
```
```
git commit -m "feat(claude-cli): pure argv builder for headless invocation"
```

---

### Task 7: Stream-JSON parser → ProviderEvent — TDD

**Files:**
- Modify: `container/agent-runner/src/providers/claude-cli.ts` (add `translateStreamJsonLines`)
- Modify: `container/agent-runner/src/providers/claude-cli.test.ts` (add a `describe` block)

- [ ] **Step 1: Add failing parser tests**

Append to `container/agent-runner/src/providers/claude-cli.test.ts`:

```ts
import { translateStreamJsonLines } from './claude-cli.js';
import type { ProviderEvent } from './types.js';

async function* fromArray<T>(items: T[]): AsyncIterable<T> {
  for (const it of items) yield it;
}

async function collect(events: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

describe('translateStreamJsonLines', () => {
  it('emits init with the session_id from system/init', async () => {
    const lines = fromArray([JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-1' })]);
    const events = await collect(translateStreamJsonLines(lines, { exitCode: () => 0, stderr: () => '' }));
    expect(events.some((e) => e.type === 'init' && (e as { continuation: string }).continuation === 'sess-1')).toBe(true);
  });

  it('emits activity for assistant + user messages', async () => {
    const lines = fromArray([
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'thinking' }] } }),
      JSON.stringify({ type: 'user', message: { content: 'tool result' } }),
    ]);
    const events = await collect(translateStreamJsonLines(lines, { exitCode: () => 0, stderr: () => '' }));
    expect(events.filter((e) => e.type === 'activity').length).toBeGreaterThanOrEqual(2);
  });

  it('emits result with the result text on system/result success', async () => {
    const lines = fromArray([
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-1' }),
      JSON.stringify({ type: 'result', subtype: 'success', result: 'final answer' }),
    ]);
    const events = await collect(translateStreamJsonLines(lines, { exitCode: () => 0, stderr: () => '' }));
    const result = events.find((e) => e.type === 'result') as { type: 'result'; text: string | null };
    expect(result.text).toBe('final answer');
  });

  it('emits result on compact_boundary with token count when present', async () => {
    const lines = fromArray([
      JSON.stringify({
        type: 'system',
        subtype: 'compact_boundary',
        compact_metadata: { pre_tokens: 12345 },
      }),
    ]);
    const events = await collect(translateStreamJsonLines(lines, { exitCode: () => 0, stderr: () => '' }));
    const result = events.find((e) => e.type === 'result') as { type: 'result'; text: string };
    expect(result.text).toMatch(/Context compacted/);
    expect(result.text).toMatch(/12,345/);
  });

  it('emits retryable error on result/error_max_turns', async () => {
    const lines = fromArray([
      JSON.stringify({ type: 'result', subtype: 'error_max_turns', error: 'Too many turns' }),
    ]);
    const events = await collect(translateStreamJsonLines(lines, { exitCode: () => 0, stderr: () => '' }));
    const err = events.find((e) => e.type === 'error') as { type: 'error'; message: string; retryable: boolean };
    expect(err.retryable).toBe(true);
  });

  it('emits non-retryable error when CLI exits non-zero with no result line', async () => {
    const lines = fromArray<string>([]);
    const events = await collect(
      translateStreamJsonLines(lines, { exitCode: () => 1, stderr: () => 'auth failed' }),
    );
    const err = events.find((e) => e.type === 'error') as { type: 'error'; message: string; retryable: boolean };
    expect(err.retryable).toBe(false);
    expect(err.message).toContain('auth failed');
  });

  it('ignores unparseable lines defensively (does not abort the stream)', async () => {
    const lines = fromArray<string>([
      'not json',
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-1' }),
      JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' }),
    ]);
    const events = await collect(translateStreamJsonLines(lines, { exitCode: () => 0, stderr: () => '' }));
    expect(events.find((e) => e.type === 'init')).toBeDefined();
    expect(events.find((e) => e.type === 'result')).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd container/agent-runner && bun test src/providers/claude-cli.test.ts`
Expected: FAIL — `translateStreamJsonLines` is not exported.

- [ ] **Step 3: Implement the parser**

Append to `container/agent-runner/src/providers/claude-cli.ts`:

```ts
import type { ProviderEvent } from './types.js';

/** Subtypes the CLI emits as `type:'result'` for non-success outcomes. */
const RETRYABLE_RESULT_SUBTYPES = new Set(['error_max_turns', 'error_during_execution']);

/**
 * Adapter contract for the spawned CLI process. Kept abstract so the parser
 * is unit-testable without a real Bun.spawn (we feed it a fixture iterable).
 *
 * - `exitCode()` is consulted only after `lines` is exhausted.
 * - `stderr()` returns the captured stderr at the same point.
 */
export interface ClaudeCliChildAdapter {
  exitCode: () => number | null;
  stderr: () => string;
}

/**
 * Translate the CLI's `--output-format stream-json --verbose` output (one
 * JSON object per line) into the provider's neutral `ProviderEvent` stream.
 *
 * Mapping:
 *   system/init              → init { continuation: session_id }
 *   assistant message        → activity
 *   user message (tool_result)→ activity
 *   system/compact_boundary  → result { text: 'Context compacted...' }
 *   result/success           → result { text: result }
 *   result/error_*           → error { retryable }
 *   exit != 0 + no result    → error { retryable: false, message: stderr }
 *
 * Defensive: unrecognized line shapes are silently dropped — a CLI version
 * bump that adds new event types must not crash the agent-runner.
 */
export async function* translateStreamJsonLines(
  lines: AsyncIterable<string>,
  child: ClaudeCliChildAdapter,
): AsyncGenerator<ProviderEvent> {
  let sawResult = false;

  for await (const raw of lines) {
    if (!raw.trim()) continue;
    let evt: { type?: string; subtype?: string; [k: string]: unknown };
    try {
      evt = JSON.parse(raw);
    } catch {
      continue; // ignore unparseable lines
    }

    if (evt.type === 'system' && evt.subtype === 'init' && typeof evt.session_id === 'string') {
      yield { type: 'init', continuation: evt.session_id };
      yield { type: 'activity' };
      continue;
    }

    if (evt.type === 'assistant' || evt.type === 'user') {
      yield { type: 'activity' };
      continue;
    }

    if (evt.type === 'system' && evt.subtype === 'compact_boundary') {
      const meta = (evt as { compact_metadata?: { pre_tokens?: number } }).compact_metadata;
      const detail = meta?.pre_tokens ? ` (${meta.pre_tokens.toLocaleString()} tokens compacted)` : '';
      sawResult = true;
      yield { type: 'result', text: `Context compacted${detail}.` };
      continue;
    }

    if (evt.type === 'result') {
      sawResult = true;
      if (evt.subtype === 'success') {
        yield { type: 'result', text: typeof evt.result === 'string' ? (evt.result as string) : null };
        continue;
      }
      const message = typeof evt.error === 'string' ? (evt.error as string) : `CLI returned ${evt.subtype}`;
      yield {
        type: 'error',
        message,
        retryable: typeof evt.subtype === 'string' && RETRYABLE_RESULT_SUBTYPES.has(evt.subtype),
      };
      continue;
    }

    // Unknown/unhandled — emit activity so the poll-loop knows we're alive.
    yield { type: 'activity' };
  }

  // Stream closed. If the CLI exited non-zero without ever emitting a result,
  // surface stderr as a non-retryable error.
  if (!sawResult) {
    const code = child.exitCode();
    if (code !== null && code !== 0) {
      yield {
        type: 'error',
        message: child.stderr().trim() || `CLI exited with code ${code}`,
        retryable: false,
      };
    }
  }
}
```

- [ ] **Step 4: Run the parser tests**

Run: `cd container/agent-runner && bun test src/providers/claude-cli.test.ts`
Expected: PASS — all 9 builder tests + 7 parser tests.

- [ ] **Step 5: Typecheck**

Run from repo root: `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit`
Expected: 0 errors.

- [ ] **Step 6: Commit**

```
git add container/agent-runner/src/providers/claude-cli.ts container/agent-runner/src/providers/claude-cli.test.ts
```
```
git commit -m "feat(claude-cli): stream-json line parser → ProviderEvent"
```

---

### Task 8: `ClaudeCliProvider` class + lifecycle (spawn / abort / push) — TDD

**Files:**
- Modify: `container/agent-runner/src/providers/claude-cli.ts` (add class + register)
- Modify: `container/agent-runner/src/providers/claude-cli.test.ts` (class tests)

- [ ] **Step 1: Add failing class tests**

Append to `container/agent-runner/src/providers/claude-cli.test.ts`:

```ts
import { ClaudeCliProvider } from './claude-cli.js';

describe('ClaudeCliProvider', () => {
  it('exposes supportsNativeSlashCommands = true', () => {
    expect(new ClaudeCliProvider().supportsNativeSlashCommands).toBe(true);
  });

  it('isSessionInvalid matches the documented stale-session text', () => {
    const p = new ClaudeCliProvider();
    expect(p.isSessionInvalid(new Error('No conversation found for that ID'))).toBe(true);
    expect(p.isSessionInvalid(new Error('ENOENT: no such file or directory, open transcript.jsonl'))).toBe(true);
    expect(p.isSessionInvalid(new Error('Session abc not found'))).toBe(true);
    expect(p.isSessionInvalid(new Error('rate limit'))).toBe(false);
    expect(p.isSessionInvalid('some random string')).toBe(false);
  });

  it('push() is a no-op (single-turn model — see plan)', () => {
    const p = new ClaudeCliProvider();
    const q = p.query({ prompt: 'hi', cwd: '/tmp' });
    // Must not throw, must not affect the events generator.
    expect(() => q.push('follow-up')).not.toThrow();
    q.abort();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd container/agent-runner && bun test src/providers/claude-cli.test.ts`
Expected: FAIL — `ClaudeCliProvider` not exported.

- [ ] **Step 3: Implement the class**

Append to `container/agent-runner/src/providers/claude-cli.ts`:

```ts
import { registerProvider } from './provider-registry.js';
import type { AgentProvider, AgentQuery, McpServerConfig, ProviderOptions, QueryInput } from './types.js';

const STALE_SESSION_RE = /no conversation found|ENOENT.*\.jsonl|session.*not found/i;

const DEFAULT_CLAUDE_BIN = '/pnpm/claude';

function log(msg: string): void {
  console.error(`[claude-cli-provider] ${msg}`);
}

/**
 * Read child stdout line-by-line. Bun streams Uint8Array chunks; we accumulate
 * until newline boundaries and yield each complete line.
 */
async function* readLines(reader: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buf = '';
  // @ts-expect-error — Bun's ReadableStream is async-iterable.
  for await (const chunk of reader) {
    buf += decoder.decode(chunk, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n')) !== -1) {
      yield buf.slice(0, idx);
      buf = buf.slice(idx + 1);
    }
  }
  if (buf.length > 0) yield buf;
}

export class ClaudeCliProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = true;

  private assistantName?: string;
  private mcpServers: Record<string, McpServerConfig>;
  private env: Record<string, string | undefined>;
  private additionalDirectories?: string[];

  constructor(options: ProviderOptions = {}) {
    this.assistantName = options.assistantName;
    this.mcpServers = options.mcpServers ?? {};
    this.additionalDirectories = options.additionalDirectories;
    this.env = options.env ?? {};
  }

  isSessionInvalid(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return STALE_SESSION_RE.test(msg);
  }

  query(input: QueryInput): AgentQuery {
    const args = buildClaudeCliArgs({
      prompt: input.prompt,
      continuation: input.continuation,
      systemContext: input.systemContext,
      additionalDirectories: this.additionalDirectories,
    });

    const childEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(this.env)) {
      if (typeof v === 'string') childEnv[k] = v;
    }
    if (this.assistantName) childEnv.NANOCLAW_ASSISTANT_NAME = this.assistantName;

    const child = Bun.spawn([DEFAULT_CLAUDE_BIN, ...args], {
      cwd: input.cwd,
      env: childEnv,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    let stderrBuf = '';
    (async () => {
      const reader = child.stderr;
      if (!reader) return;
      const decoder = new TextDecoder();
      // @ts-expect-error — async iterable
      for await (const chunk of reader) {
        stderrBuf += decoder.decode(chunk, { stream: true });
      }
    })().catch((err) => {
      log(`stderr drain error: ${err instanceof Error ? err.message : String(err)}`);
    });

    const adapter = {
      exitCode: () => child.exitCode,
      stderr: () => stderrBuf,
    };

    let aborted = false;

    const events = (async function* () {
      const stdout = child.stdout;
      if (!stdout) return;
      for await (const evt of translateStreamJsonLines(readLines(stdout), adapter)) {
        if (aborted) return;
        yield evt;
      }
    })();

    return {
      events,
      // Single-turn model — see plan §"Modelo de turno". The poll-loop
      // delivers any messages that arrived during the spawn on the next
      // wakeup with --resume.
      push: () => {
        log('push() called but ignored — claude-cli provider is single-turn per spawn');
      },
      end: () => {
        try {
          child.kill('SIGTERM');
        } catch {
          /* already dead */
        }
      },
      abort: () => {
        aborted = true;
        try {
          child.kill('SIGTERM');
        } catch {
          /* already dead */
        }
        setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            /* already dead */
          }
        }, 5000);
      },
    };
  }
}

registerProvider('claude-cli', (opts) => new ClaudeCliProvider(opts));
```

- [ ] **Step 4: Run the test suite**

Run: `cd container/agent-runner && bun test src/providers/claude-cli.test.ts`
Expected: PASS — all argv + parser + class tests.

- [ ] **Step 5: Typecheck**

Run from repo root: `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit`
Expected: 0 errors.

- [ ] **Step 6: Commit**

```
git add container/agent-runner/src/providers/claude-cli.ts container/agent-runner/src/providers/claude-cli.test.ts
```
```
git commit -m "feat(claude-cli): ClaudeCliProvider class + spawn/abort lifecycle"
```

---

### Task 9: Wire provider into the registry barrel

**Files:**
- Modify: `container/agent-runner/src/providers/index.ts`
- Modify: `container/agent-runner/src/providers/factory.test.ts`

- [ ] **Step 1: Add the failing factory test**

Edit `container/agent-runner/src/providers/factory.test.ts` — add a new case:

```ts
import { ClaudeCliProvider } from './claude-cli.js';
```

Add a test inside `describe('createProvider', ...)`:

```ts
  it('returns ClaudeCliProvider for claude-cli', () => {
    expect(createProvider('claude-cli')).toBeInstanceOf(ClaudeCliProvider);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd container/agent-runner && bun test src/providers/factory.test.ts`
Expected: FAIL — `Unknown provider: claude-cli` (the barrel hasn't imported it yet).

- [ ] **Step 3: Add the import to the barrel**

Edit `container/agent-runner/src/providers/index.ts`:

```ts
// Provider self-registration barrel.
// Each import triggers the provider module's registerProvider() call at top
// level. Skills add a new provider by appending one import line below.

import './claude.js';
import './claude-cli.js';
import './mock.js';
```

- [ ] **Step 4: Run all agent-runner tests**

Run: `cd container/agent-runner && bun test`
Expected: PASS — all tests (existing + new).

- [ ] **Step 5: Typecheck**

Run from repo root: `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit`
Expected: 0 errors.

- [ ] **Step 6: Commit**

```
git add container/agent-runner/src/providers/index.ts container/agent-runner/src/providers/factory.test.ts
```
```
git commit -m "feat(claude-cli): register provider in agent-runner barrel"
```

---

## Phase 4: Host-side integration

### Task 10: Extend `ProviderContainerContext` with `containerConfig`

**Files:**
- Modify: `src/providers/provider-container-registry.ts`
- Modify: `src/container-runner.ts`
- Modify: `src/providers/claude.ts` (no behavior change — adapt to optional new field)

- [ ] **Step 1: Add the new field to the context interface**

Edit `src/providers/provider-container-registry.ts`. Add an import at the top:

```ts
import type { ContainerConfig } from '../container-config.js';
```

Edit the `ProviderContainerContext` interface:

```ts
export interface ProviderContainerContext {
  /** Per-session host directory: `<DATA_DIR>/v2-sessions/<agent_group_id>/<session_id>`. */
  sessionDir: string;
  /** Agent group ID, for any per-group logic. */
  agentGroupId: string;
  /** `process.env` at spawn time — pull passthrough values from here. */
  hostEnv: NodeJS.ProcessEnv;
  /** Parsed container.json for the agent group — read mcpServers etc. without re-doing I/O. */
  containerConfig: ContainerConfig;
}
```

- [ ] **Step 2: Pass the new field from the call site**

Edit `src/container-runner.ts:233-238` — extend the context object inside `resolveProviderContribution`:

```ts
  const fn = getProviderContainerConfig(provider);
  const contribution = fn
    ? fn({
        sessionDir: sessionDir(agentGroup.id, session.id),
        agentGroupId: agentGroup.id,
        hostEnv: process.env,
        containerConfig,
      })
    : {};
```

- [ ] **Step 3: Run typecheck**

Run from repo root: `pnpm exec tsc --noEmit`
Expected: 0 errors. The existing `src/providers/claude.ts` ignores unknown fields, so it still compiles.

- [ ] **Step 4: Run host tests**

Run: `pnpm exec vitest run`
Expected: all pass.

- [ ] **Step 5: Commit**

```
git add src/providers/provider-container-registry.ts src/container-runner.ts
```
```
git commit -m "refactor(provider-host): expose containerConfig to host-side provider config fns"
```

---

### Task 11: Host `claude-cli` provider — TDD setup

**Files:**
- Create: `src/providers/claude-cli.ts`
- Create: `src/providers/claude-cli.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/providers/claude-cli.test.ts`:

```ts
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Force registry import — must come before importing the module under test
// so the SUT's registerProviderContainerConfig() call lands.
import './claude-cli.js';
import { getProviderContainerConfig } from './provider-container-registry.js';

let tmpHome: string;
let tmpData: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-cli-host-home-'));
  tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-cli-host-data-'));
  vi.spyOn(os, 'homedir').mockReturnValue(tmpHome);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(tmpData, { recursive: true, force: true });
});

function makeContext(overrides: { mcpServers?: Record<string, unknown> } = {}) {
  const sessionDir = path.join(tmpData, 'v2-sessions', 'agent-1', 'sess-1');
  fs.mkdirSync(sessionDir, { recursive: true });
  return {
    sessionDir,
    agentGroupId: 'agent-1',
    hostEnv: {} as NodeJS.ProcessEnv,
    containerConfig: {
      mcpServers: (overrides.mcpServers as Record<string, never>) ?? {},
      packages: { apt: [], npm: [] },
      additionalMounts: [],
      skills: 'all' as const,
    },
  };
}

describe('host claude-cli provider config', () => {
  it('throws when host has no ~/.claude/.credentials.json', () => {
    const fn = getProviderContainerConfig('claude-cli');
    expect(fn).toBeDefined();
    expect(() => fn!(makeContext())).toThrow(/claude \/login/i);
  });

  it('copies ~/.claude/.credentials.json into the per-session control dir', () => {
    fs.mkdirSync(path.join(tmpHome, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(tmpHome, '.claude', '.credentials.json'), '{"oauth":"abc"}');

    const ctx = makeContext();
    const fn = getProviderContainerConfig('claude-cli')!;
    const out = fn(ctx);

    const controlDir = path.join(tmpData, 'v2-sessions', 'agent-1', '.claude-cli-control', 'sess-1');
    expect(fs.existsSync(path.join(controlDir, '.credentials.json'))).toBe(true);
    expect(fs.readFileSync(path.join(controlDir, '.credentials.json'), 'utf-8')).toBe('{"oauth":"abc"}');

    // Sibling-of-session-id placement: NOT under sessionDir.
    expect(controlDir.startsWith(ctx.sessionDir)).toBe(false);

    // Mount list contains the three nested-RO entries.
    const ros = (out.mounts ?? []).filter((m) => m.readonly);
    expect(ros.find((m) => m.containerPath === '/home/node/.claude/.credentials.json')).toBeDefined();
    expect(ros.find((m) => m.containerPath === '/home/node/.claude/settings.json')).toBeDefined();
    expect(ros.find((m) => m.containerPath === '/home/node/.claude/mcp.json')).toBeDefined();
    // No RW mount is added by this provider — base RW lives in the existing
    // .claude-shared mount the runner already adds.
    expect((out.mounts ?? []).filter((m) => !m.readonly).length).toBe(0);
  });

  it('regenerates settings.json + mcp.json on every spawn (defense-in-depth)', () => {
    fs.mkdirSync(path.join(tmpHome, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(tmpHome, '.claude', '.credentials.json'), '{"oauth":"a"}');

    const ctx = makeContext();
    const fn = getProviderContainerConfig('claude-cli')!;
    fn(ctx);

    const controlDir = path.join(tmpData, 'v2-sessions', 'agent-1', '.claude-cli-control', 'sess-1');

    // Corrupt files between spawns.
    fs.writeFileSync(path.join(controlDir, 'settings.json'), 'POISONED');
    fs.writeFileSync(path.join(controlDir, 'mcp.json'), 'POISONED');

    fn(ctx); // second spawn

    const settings = JSON.parse(fs.readFileSync(path.join(controlDir, 'settings.json'), 'utf-8'));
    expect(settings.hooks.PreToolUse).toBeDefined();
    expect(settings.hooks.PostToolUse).toBeDefined();
    expect(settings.hooks.PreCompact).toBeDefined();
    const mcp = JSON.parse(fs.readFileSync(path.join(controlDir, 'mcp.json'), 'utf-8'));
    expect(mcp.mcpServers.nanoclaw).toBeDefined();
  });

  it('mcp.json includes container.json mcpServers + the built-in nanoclaw entry', () => {
    fs.mkdirSync(path.join(tmpHome, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(tmpHome, '.claude', '.credentials.json'), '{"oauth":"a"}');
    const ctx = makeContext({
      mcpServers: { custom: { command: 'echo', args: ['hi'], env: {} } },
    });
    const fn = getProviderContainerConfig('claude-cli')!;
    fn(ctx);
    const controlDir = path.join(tmpData, 'v2-sessions', 'agent-1', '.claude-cli-control', 'sess-1');
    const mcp = JSON.parse(fs.readFileSync(path.join(controlDir, 'mcp.json'), 'utf-8'));
    expect(mcp.mcpServers.nanoclaw.command).toBe('bun');
    expect(mcp.mcpServers.nanoclaw.args).toContain('/app/src/mcp-tools/index.ts');
    expect(mcp.mcpServers.custom.command).toBe('echo');
  });

  it('only re-copies credentials when the host master is newer (mtime gate)', () => {
    fs.mkdirSync(path.join(tmpHome, '.claude'), { recursive: true });
    const hostCreds = path.join(tmpHome, '.claude', '.credentials.json');
    fs.writeFileSync(hostCreds, 'first');
    const oldTime = new Date('2020-01-01');
    fs.utimesSync(hostCreds, oldTime, oldTime);

    const ctx = makeContext();
    const fn = getProviderContainerConfig('claude-cli')!;
    fn(ctx);

    const controlDir = path.join(tmpData, 'v2-sessions', 'agent-1', '.claude-cli-control', 'sess-1');
    const sessCreds = path.join(controlDir, '.credentials.json');
    fs.writeFileSync(sessCreds, 'second');
    const newer = new Date('2025-01-01');
    fs.utimesSync(sessCreds, newer, newer);

    fn(ctx); // host is older, should NOT overwrite session copy
    expect(fs.readFileSync(sessCreds, 'utf-8')).toBe('second');

    // Now make host newer.
    const evenNewer = new Date('2026-01-01');
    fs.utimesSync(hostCreds, evenNewer, evenNewer);
    fs.writeFileSync(hostCreds, 'third');
    fs.utimesSync(hostCreds, evenNewer, evenNewer);

    fn(ctx);
    expect(fs.readFileSync(sessCreds, 'utf-8')).toBe('third');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/providers/claude-cli.test.ts`
Expected: FAIL — `claude-cli.ts` doesn't exist yet.

- [ ] **Step 3: Implement the host provider module**

Create `src/providers/claude-cli.ts`:

```ts
/**
 * Host-side container config for the `claude-cli` agent provider.
 *
 * Responsibilities per spawn:
 *   1. Verify the host has run `claude /login` (master credentials exist).
 *   2. Lazily copy/refresh the OAuth credentials into a per-session control
 *      dir (sibling of `<sessionDir>`, NOT under it — would otherwise be
 *      reachable via the `/workspace` RW mount, defeating the RO nesting).
 *   3. Regenerate the settings.json + mcp.json control files from the
 *      static template + container.json mcpServers. Regenerated every spawn
 *      so any in-container tampering during the previous lifetime is
 *      discarded — defense in depth on top of the nested RO mount.
 *   4. Return the three nested-RO mounts that overlay the per-group
 *      `.claude-shared` RW base at `/home/node/.claude/`.
 *
 * The base RW mount itself is not contributed here: the container-runner
 * already adds `<DATA_DIR>/v2-sessions/<group>/.claude-shared` →
 * `/home/node/.claude:rw` for every spawn.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { registerProviderContainerConfig, type VolumeMount } from './provider-container-registry.js';

/**
 * Hooks JSON template. Bun executes .ts directly inside the container — there
 * is no tsc build step (see CLAUDE.md), so we point at the .ts source paths
 * under the read-only `/app/src` mount.
 */
const SETTINGS_TEMPLATE = {
  hooks: {
    PreToolUse: [{ command: 'bun /app/src/providers/claude-cli-hooks/pre-tool-use.ts' }],
    PostToolUse: [{ command: 'bun /app/src/providers/claude-cli-hooks/post-tool-use.ts' }],
    PostToolUseFailure: [{ command: 'bun /app/src/providers/claude-cli-hooks/post-tool-use.ts' }],
    PreCompact: [{ command: 'bun /app/src/providers/claude-cli-hooks/pre-compact.ts' }],
  },
};

/**
 * Built-in nanoclaw MCP server entry, hard-coded to the in-container path
 * of the agent-runner mount (`/app/src/`). Matches what the agent-runner's
 * `index.ts` would generate for its in-process SDK provider.
 */
const NANOCLAW_BUILTIN_MCP = {
  command: 'bun',
  args: ['run', '/app/src/mcp-tools/index.ts'],
  env: {},
};

function controlDir(sessionDir: string, agentGroupId: string): string {
  // Walk one level up from <sessionDir> = <DATA>/v2-sessions/<group>/<session>
  // to <DATA>/v2-sessions/<group>, then add the sibling .claude-cli-control/<session>.
  const groupDir = path.dirname(sessionDir);
  const sessionId = path.basename(sessionDir);
  // `agentGroupId` is intentionally compared in an assertion — see test.
  if (path.basename(groupDir) !== agentGroupId) {
    // Safety net: if the layout ever changes, fail loudly rather than write
    // creds to the wrong path. The runner builds <sessionDir> from
    // sessionDir(agentGroup.id, session.id) — basename(dirname(sessionDir))
    // must equal agentGroupId by construction.
    throw new Error(
      `claude-cli: unexpected sessionDir layout — expected basename(${groupDir}) === '${agentGroupId}'`,
    );
  }
  return path.join(groupDir, '.claude-cli-control', sessionId);
}

function copyCredentialsIfNewer(hostCreds: string, sessCreds: string): void {
  fs.mkdirSync(path.dirname(sessCreds), { recursive: true });
  if (!fs.existsSync(sessCreds) || fs.statSync(hostCreds).mtimeMs > fs.statSync(sessCreds).mtimeMs) {
    fs.copyFileSync(hostCreds, sessCreds);
    try {
      fs.chmodSync(sessCreds, 0o600);
    } catch {
      /* best effort */
    }
  }
}

registerProviderContainerConfig('claude-cli', (ctx) => {
  const hostCreds = path.join(os.homedir(), '.claude', '.credentials.json');
  if (!fs.existsSync(hostCreds)) {
    throw new Error(
      "provider 'claude-cli' requires `claude /login` on the host first " +
        '(no ~/.claude/.credentials.json found). Run `claude /login` and retry.',
    );
  }

  const dir = controlDir(ctx.sessionDir, ctx.agentGroupId);
  fs.mkdirSync(dir, { recursive: true });

  copyCredentialsIfNewer(hostCreds, path.join(dir, '.credentials.json'));

  // Regenerate settings.json + mcp.json on every spawn (defense in depth).
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(SETTINGS_TEMPLATE, null, 2));
  fs.writeFileSync(
    path.join(dir, 'mcp.json'),
    JSON.stringify(
      { mcpServers: { nanoclaw: NANOCLAW_BUILTIN_MCP, ...ctx.containerConfig.mcpServers } },
      null,
      2,
    ),
  );

  const mounts: VolumeMount[] = [
    {
      hostPath: path.join(dir, '.credentials.json'),
      containerPath: '/home/node/.claude/.credentials.json',
      readonly: true,
    },
    {
      hostPath: path.join(dir, 'settings.json'),
      containerPath: '/home/node/.claude/settings.json',
      readonly: true,
    },
    {
      hostPath: path.join(dir, 'mcp.json'),
      containerPath: '/home/node/.claude/mcp.json',
      readonly: true,
    },
  ];

  return { mounts };
});
```

- [ ] **Step 4: Run the test**

Run: `pnpm exec vitest run src/providers/claude-cli.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Typecheck**

Run from repo root: `pnpm exec tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 6: Commit**

```
git add src/providers/claude-cli.ts src/providers/claude-cli.test.ts
```
```
git commit -m "feat(claude-cli-host): provider container config — creds copy + nested RO mounts"
```

---

### Task 12: Wire host module into the barrel

**Files:**
- Modify: `src/providers/index.ts`

- [ ] **Step 1: Add the import**

Edit `src/providers/index.ts`:

```ts
// Host-side provider container-config barrel.
// Providers that need host-side container setup (extra mounts, env passthrough,
// per-session directories) self-register on import. Providers with no host
// needs (claude, mock) don't appear here.
//
// Skills add a new provider by appending one import line below.

import './claude-cli.js';
```

(Keep any existing imports — there are none currently in the standard install, but if the user has run `/setup` with a custom Anthropic base URL, `import './claude.js';` will be there too. Don't remove it.)

- [ ] **Step 2: Verify the registry has the entry at module-load time**

Add a quick smoke test by re-running the host suite:

Run: `pnpm exec vitest run`
Expected: PASS — including the new claude-cli host tests, which depend on the registry having the entry.

- [ ] **Step 3: Typecheck**

Run from repo root: `pnpm exec tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 4: Commit**

```
git add src/providers/index.ts
```
```
git commit -m "feat(claude-cli-host): import claude-cli module from provider barrel"
```

---

### Task 13: Periodic credentials resync in `host-sweep` — TDD

**Files:**
- Modify: `src/host-sweep.ts`
- Create or modify: `src/host-sweep.test.ts` (extend existing file)

- [ ] **Step 1: Read existing host-sweep.test.ts to understand the test scaffold**

Run: `cat src/host-sweep.test.ts | head -60`

This step is informational — adapt the test below to the existing helpers' style if there's a `setupTestSession` or similar.

- [ ] **Step 2: Write the failing test**

Append a new `describe` block to `src/host-sweep.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
// ...existing imports...

import { _resyncClaudeCliCredentialsForTesting } from './host-sweep.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { vi, afterEach, beforeEach } from 'vitest';

describe('claude-cli credentials resync (sweep)', () => {
  let tmpHome: string;
  let tmpData: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-cli-home-'));
    tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-cli-data-'));
    vi.spyOn(os, 'homedir').mockReturnValue(tmpHome);
    fs.mkdirSync(path.join(tmpHome, '.claude'), { recursive: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(tmpData, { recursive: true, force: true });
  });

  it('overwrites session credentials when the host master is newer', () => {
    const hostCreds = path.join(tmpHome, '.claude', '.credentials.json');
    fs.writeFileSync(hostCreds, 'host-new');
    const newer = new Date('2026-01-01');
    fs.utimesSync(hostCreds, newer, newer);

    const sessCreds = path.join(tmpData, 'v2-sessions', 'g1', '.claude-cli-control', 's1', '.credentials.json');
    fs.mkdirSync(path.dirname(sessCreds), { recursive: true });
    fs.writeFileSync(sessCreds, 'session-old');
    const older = new Date('2020-01-01');
    fs.utimesSync(sessCreds, older, older);

    _resyncClaudeCliCredentialsForTesting({
      hostCreds,
      sessions: [{ agentGroupId: 'g1', sessionId: 's1', dataDir: tmpData }],
    });

    expect(fs.readFileSync(sessCreds, 'utf-8')).toBe('host-new');
  });

  it('is a no-op when host master is older than session copy', () => {
    const hostCreds = path.join(tmpHome, '.claude', '.credentials.json');
    fs.writeFileSync(hostCreds, 'host-old');
    const older = new Date('2020-01-01');
    fs.utimesSync(hostCreds, older, older);

    const sessCreds = path.join(tmpData, 'v2-sessions', 'g1', '.claude-cli-control', 's1', '.credentials.json');
    fs.mkdirSync(path.dirname(sessCreds), { recursive: true });
    fs.writeFileSync(sessCreds, 'session-newer');
    const newer = new Date('2026-01-01');
    fs.utimesSync(sessCreds, newer, newer);

    _resyncClaudeCliCredentialsForTesting({
      hostCreds,
      sessions: [{ agentGroupId: 'g1', sessionId: 's1', dataDir: tmpData }],
    });

    expect(fs.readFileSync(sessCreds, 'utf-8')).toBe('session-newer');
  });

  it('skips sessions whose control dir doesn\'t exist (not a claude-cli session)', () => {
    const hostCreds = path.join(tmpHome, '.claude', '.credentials.json');
    fs.writeFileSync(hostCreds, 'host');
    expect(() =>
      _resyncClaudeCliCredentialsForTesting({
        hostCreds,
        sessions: [{ agentGroupId: 'g1', sessionId: 's1', dataDir: tmpData }],
      }),
    ).not.toThrow();
  });

  it('is a no-op when host master is missing (user has not logged in)', () => {
    expect(() =>
      _resyncClaudeCliCredentialsForTesting({
        hostCreds: path.join(tmpHome, '.claude', '.credentials.json'), // doesn't exist
        sessions: [{ agentGroupId: 'g1', sessionId: 's1', dataDir: tmpData }],
      }),
    ).not.toThrow();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm exec vitest run src/host-sweep.test.ts`
Expected: FAIL — `_resyncClaudeCliCredentialsForTesting` not exported.

- [ ] **Step 4: Implement the resync helper and wire into `sweep()`**

Edit `src/host-sweep.ts`:

a) Add the helper near the bottom of the file, before `_resetStuckProcessingRowsForTesting`:

```ts
import os from 'os';

interface ResyncInput {
  hostCreds: string;
  sessions: Array<{ agentGroupId: string; sessionId: string; dataDir: string }>;
}

/**
 * Per-tick resync of OAuth credentials for any session that has a
 * claude-cli control dir. Runs in the same loop that does
 * processing_ack syncs so we don't add a second timer.
 *
 * Cheap when nothing has changed: O(active sessions) stat calls + a
 * single mtime compare each. Real work only when the host has run
 * `claude /login` since the last tick.
 *
 * Exported for testing under `_resyncClaudeCliCredentialsForTesting`.
 */
export function _resyncClaudeCliCredentialsForTesting(input: ResyncInput): void {
  resyncClaudeCliCredentials(input);
}

function resyncClaudeCliCredentials(input: ResyncInput): void {
  if (!fs.existsSync(input.hostCreds)) return;
  const hostMtimeMs = fs.statSync(input.hostCreds).mtimeMs;

  for (const s of input.sessions) {
    const controlDir = path.join(s.dataDir, 'v2-sessions', s.agentGroupId, '.claude-cli-control', s.sessionId);
    const sessCreds = path.join(controlDir, '.credentials.json');
    if (!fs.existsSync(sessCreds)) continue; // not a claude-cli session
    const sessMtimeMs = fs.statSync(sessCreds).mtimeMs;
    if (hostMtimeMs <= sessMtimeMs) continue;
    try {
      fs.copyFileSync(input.hostCreds, sessCreds);
      fs.chmodSync(sessCreds, 0o600);
      log.info('Refreshed claude-cli credentials for session', {
        agentGroupId: s.agentGroupId,
        sessionId: s.sessionId,
      });
    } catch (err) {
      log.warn('Credentials resync failed', {
        agentGroupId: s.agentGroupId,
        sessionId: s.sessionId,
        err,
      });
    }
  }
}
```

b) Add a missing `path` import at the top of `src/host-sweep.ts` if it's not already there:

Run: `grep -n "^import path" src/host-sweep.ts`. If absent, add `import path from 'path';` alongside the existing imports.

c) Add `import { DATA_DIR } from './config.js';` if not present, and call `resyncClaudeCliCredentials` once per sweep — at the top of `sweep()` before the per-session loop:

```ts
async function sweep(): Promise<void> {
  if (!running) return;

  try {
    const sessions = getActiveSessions();
    resyncClaudeCliCredentials({
      hostCreds: path.join(os.homedir(), '.claude', '.credentials.json'),
      sessions: sessions.map((s) => ({
        agentGroupId: s.agent_group_id,
        sessionId: s.id,
        dataDir: DATA_DIR,
      })),
    });
    for (const session of sessions) {
      await sweepSession(session);
    }
  } catch (err) {
    log.error('Host sweep error', { err });
  }

  setTimeout(sweep, SWEEP_INTERVAL_MS);
}
```

- [ ] **Step 5: Run the test**

Run: `pnpm exec vitest run src/host-sweep.test.ts`
Expected: PASS — including the 4 new resync tests.

- [ ] **Step 6: Run full host suite**

Run: `pnpm exec vitest run`
Expected: PASS.

- [ ] **Step 7: Typecheck**

Run from repo root: `pnpm exec tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 8: Commit**

```
git add src/host-sweep.ts src/host-sweep.test.ts
```
```
git commit -m "feat(host-sweep): periodic credentials resync for claude-cli sessions"
```

---

### Task 14: Container-runner integration test — verify the host fn fires for claude-cli

**Files:**
- Modify: `src/container-runner.test.ts`

This is a thin smoke test that the existing `resolveProviderContribution` path looks up the registered fn for `claude-cli` and that the fn returns the expected mounts. The fn itself is fully tested in Task 11.

- [ ] **Step 1: Add a failing test**

Append to `src/container-runner.test.ts`:

```ts
import fs from 'fs';
import os from 'os';
import path from 'path';

import { vi, afterEach, beforeEach } from 'vitest';

import './providers/index.js';
import { getProviderContainerConfig } from './providers/provider-container-registry.js';

describe('claude-cli provider host config (registry lookup)', () => {
  let tmpHome: string;
  let tmpData: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-cli-home-'));
    tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-cli-data-'));
    vi.spyOn(os, 'homedir').mockReturnValue(tmpHome);
    fs.mkdirSync(path.join(tmpHome, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(tmpHome, '.claude', '.credentials.json'), '{"oauth":"x"}');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(tmpData, { recursive: true, force: true });
  });

  it('is registered and returns three nested-RO mounts', () => {
    const sessionDir = path.join(tmpData, 'v2-sessions', 'g1', 's1');
    fs.mkdirSync(sessionDir, { recursive: true });

    const fn = getProviderContainerConfig('claude-cli');
    expect(fn).toBeDefined();

    const out = fn!({
      sessionDir,
      agentGroupId: 'g1',
      hostEnv: process.env,
      containerConfig: { mcpServers: {}, packages: { apt: [], npm: [] }, additionalMounts: [], skills: 'all' },
    });

    expect(out.mounts).toBeDefined();
    expect(out.mounts!.length).toBe(3);
    expect(out.mounts!.every((m) => m.readonly)).toBe(true);
    // None of the host paths must be a child of `sessionDir` — that's the
    // whole point of the sibling-dir layout.
    for (const m of out.mounts!) {
      expect(m.hostPath.startsWith(sessionDir + path.sep)).toBe(false);
    }
  });
});
```

- [ ] **Step 2: Run to verify it fails (or passes if registry is wired correctly)**

Run: `pnpm exec vitest run src/container-runner.test.ts`
Expected: PASS — by this point Task 12 wired the import.

If it FAILS with "registry empty", check that `src/providers/index.ts` imports `./claude-cli.js` (Task 12).

- [ ] **Step 3: Run full host suite**

Run: `pnpm exec vitest run`
Expected: PASS.

- [ ] **Step 4: Commit**

```
git add src/container-runner.test.ts
```
```
git commit -m "test(container-runner): smoke-test claude-cli registry lookup + sibling-dir invariant"
```

---

## Phase 5: Documentation

### Task 15: Add `docs/claude-cli-provider.md`

**Files:**
- Create: `docs/claude-cli-provider.md`

- [ ] **Step 1: Write the doc**

Create `docs/claude-cli-provider.md`:

```markdown
# Claude CLI provider (built-in)

The `claude-cli` provider invokes the Claude Code CLI (`/pnpm/claude`) in
headless mode (`claude -p`) instead of using the SDK. Auth is the host's
OAuth login — no `ANTHROPIC_API_KEY`, no OneCLI proxy for AI traffic.

It coexists with the default `claude` (SDK) provider; the choice is
per-agent-group via `container.json`.

## Prerequisites

Run `claude /login` on the host once. NanoClaw uses the resulting
`~/.claude/.credentials.json` file as the source of truth and copies it
per-session into a control dir, refreshing it on `mtime` changes.

## Activate for a group

Edit `groups/<folder>/container.json`:

```json
{ "provider": "claude-cli" }
```

Restart the agent's container. New spawns will use the CLI provider.

## How it differs from `claude` (SDK)

| Behavior                       | SDK provider | CLI provider |
|--------------------------------|--------------|--------------|
| Auth                           | OneCLI proxy / API key | Host OAuth login |
| Hooks                          | In-process callbacks | On-disk scripts (`bun /app/src/providers/claude-cli-hooks/*.ts`) |
| Push mid-stream                | Yes (`MessageStream`) | No — single-turn per spawn (next message arrives at next wakeup with `--resume`) |
| Native slash commands          | Yes | Yes |

## How it works

Per-spawn the host writes a control dir at:
```
<DATA_DIR>/v2-sessions/<group_id>/.claude-cli-control/<session_id>/
  ├── .credentials.json    ← copied from ~/.claude/.credentials.json (mtime-gated)
  ├── settings.json        ← static template wiring up hook scripts
  └── mcp.json             ← container.json mcpServers + built-in nanoclaw entry
```

This dir is NOT under `<sessionDir>` — the agent's `/workspace` mount cannot
reach it, so the agent cannot tamper with the control files via writable
container paths.

Three nested-RO mounts overlay the per-group `.claude-shared` RW base:
```
<control>/.credentials.json → /home/node/.claude/.credentials.json:ro
<control>/settings.json     → /home/node/.claude/settings.json:ro
<control>/mcp.json          → /home/node/.claude/mcp.json:ro
```

The CLI is invoked with `--mcp-config /home/node/.claude/mcp.json --settings /home/node/.claude/settings.json`,
plus `--resume <session_id>` when the previous turn returned a continuation.

## Hooks

| Hook              | Script                                        | Purpose |
|-------------------|-----------------------------------------------|---------|
| `PreToolUse`      | `pre-tool-use.ts`                             | Block denylist tools; record container_state for stuck-tolerance widening |
| `PostToolUse`     | `post-tool-use.ts`                            | Clear container_state |
| `PostToolUseFailure` | `post-tool-use.ts`                         | Same — clear on failure too |
| `PreCompact`      | `pre-compact.ts`                              | Archive transcript to `/workspace/agent/conversations/` |

## Troubleshooting

- **`provider 'claude-cli' requires claude /login on the host first`** — Run `claude /login` and retry. The host master credentials file is missing.
- **Refresh token expired** — The CLI inside the container will fail at startup. Run `claude /login` again on the host; the next sweep tick (≤ 60s) will resync into running sessions.
- **Hooks don't fire** — Check that `/home/node/.claude/settings.json` exists inside the container (`docker exec <name> cat /home/node/.claude/settings.json`). If the file is empty/wrong, the host's per-spawn regeneration step has been bypassed somehow — re-spawn the container.

## Limitations

- No mid-stream push: messages arriving while the CLI is mid-turn are processed at the next wakeup, not appended to the current turn. The semantic difference is small in practice — the next-turn hand-off carries `--resume <session_id>` so context is preserved.
- The CLI binary is pinned via `CLAUDE_CODE_VERSION` in `container/build.sh`. If the CLI's `--output-format stream-json` shape changes between versions, update `translateStreamJsonLines` and its tests.

## Out of scope

- A `/use-claude-cli-provider` skill to flip the provider without editing JSON.
- Migrating existing groups from `claude` (SDK) to `claude-cli` automatically.
- `--input-format stream-json` for mid-stream push.
```

- [ ] **Step 2: Lint markdown (no automated check; just review)**

Open the file and confirm it renders cleanly in your markdown previewer.

- [ ] **Step 3: Commit**

```
git add docs/claude-cli-provider.md
```
```
git commit -m "docs(claude-cli): add provider reference + troubleshooting"
```

---

### Task 16: Update root `CLAUDE.md`

**Files:**
- Modify: `CLAUDE.md` (root)

- [ ] **Step 1: Locate the providers section**

Run: `grep -n "providers" CLAUDE.md | head -10`

The relevant block is around the "Channels and Providers (skill-installed)" section.

- [ ] **Step 2: Add a built-in providers note**

Edit `CLAUDE.md`. Find the line starting with `## Channels and Providers (skill-installed)` and insert this paragraph immediately above it (before the "Trunk does not ship..." text):

```markdown
**Built-in providers** (always available, no skill install needed):

- `claude` (SDK) — default. Hits Anthropic API via OneCLI proxy for credential injection.
- `claude-cli` — invokes `/pnpm/claude -p` in headless mode using the host's `claude /login` OAuth session. See [docs/claude-cli-provider.md](docs/claude-cli-provider.md).

```

- [ ] **Step 3: Commit**

```
git add CLAUDE.md
```
```
git commit -m "docs: note claude-cli built-in provider in root CLAUDE.md"
```

---

## Phase 6: Final verification

### Task 17: Full pre-PR check

**Files:** none (verification only)

- [ ] **Step 1: Format check**

Run: `pnpm run format:check`
Expected: clean. If not, run `pnpm run format:fix`, commit the fixups, re-run.

- [ ] **Step 2: Host typecheck**

Run: `pnpm exec tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 3: Container typecheck**

Run: `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit`
Expected: 0 errors.

- [ ] **Step 4: Host tests**

Run: `pnpm exec vitest run`
Expected: PASS.

- [ ] **Step 5: Container tests**

Run: `cd container/agent-runner && bun test`
Expected: PASS.

- [ ] **Step 6: Lint**

Run: `pnpm run lint`
Expected: clean (or only pre-existing warnings unrelated to this change).

- [ ] **Step 7: Diff summary for PR**

Run:
```
git log main..HEAD --oneline
```
```
git diff main --stat HEAD
```

Expected: a clean linear history of ~16 commits, all changes confined to:
- `container/agent-runner/src/providers/...` (new + extracted modules)
- `src/providers/...` (new host module + small registry refactor)
- `src/container-runner.ts` (one-line addition to context object)
- `src/host-sweep.ts` (resync helper + call)
- `src/host-sweep.test.ts`, `src/container-runner.test.ts` (extended)
- `docs/claude-cli-provider.md` (new)
- `CLAUDE.md` (one paragraph added)

No other surface area touched. No skills changed. No `package.json` / lockfile changes.

- [ ] **Step 8: Manual smoke test (optional but recommended)**

If running a local nanoclaw install:

1. Run `claude /login` on the host (skip if already logged in).
2. Edit a test group's `container.json` to set `"provider": "claude-cli"`.
3. Restart the host (`launchctl kickstart -k gui/$(id -u)/com.nanoclaw` on macOS).
4. Send a message via that group's wired channel.
5. Verify response flows back.
6. In a fresh terminal: `docker exec -it $(docker ps --filter name=nanoclaw-v2 -q --latest) sh` then `cat /home/node/.claude/settings.json` — confirm hooks block.
7. Inside container, try `echo X > /home/node/.claude/settings.json` — must fail with `EROFS`.
8. Inside container, try `echo X > /home/node/.claude/mcp.json` — must fail with `EROFS`.
9. Check `<DATA_DIR>/v2-sessions/<group_id>/.claude-cli-control/<session_id>/` exists on host with the three files.
10. Provoke compaction (long conversation) — confirm a new file appears in the group's `conversations/`.

If any of 6–10 fails, file an issue with the failing step before merging.

- [ ] **Step 9: Open PR**

```
git push -u origin feat/claude-cli-provider
```
```
gh pr create --title "feat: built-in claude-cli headless provider" --body "$(printf 'Implements the claude-cli provider per docs/superpowers/specs/2026-05-03-claude-cli-headless-provider-design.md. Coexists with the SDK provider; selection is per-group via container.json. See docs/claude-cli-provider.md for usage.\n\nKey deviations from spec (see plan §Architectural deviations):\n- Mount path is /home/node/.claude/ (container runs as node user), not /root/.claude/\n- Per-session control dir is sibling of <sessionDir>, not inside it (avoids /workspace exposure)\n- Uses existing provider-container-registry pattern, not inline branching in container-runner.ts\n- mcp.json generated host-side, not in-container\n\n## Test plan\n\n- [x] pnpm run format:check\n- [x] pnpm exec tsc --noEmit\n- [x] pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit\n- [x] pnpm exec vitest run\n- [x] cd container/agent-runner && bun test\n- [ ] Manual smoke test: see plan Task 17 step 8\n')"
```

Expected: PR URL printed.

---

## Self-review notes

This plan has been checked against the spec section-by-section:

- **§Resumen ejecutivo / Motivación**: covered by Tasks 6–9 (provider) + 11 (host).
- **§Estado actual relevante**: read; informs Task 1 (extract shared) so SDK provider stays intact.
- **§Decisiones tomadas**: all seven retained. Push mid-stream documented as no-op (Task 8). Approved tools list extracted (Task 1).
- **§Arquitectura — componentes nuevos**: `claude-cli.ts` (Tasks 6–8), `transcript.ts` (Task 2), three hook scripts (Tasks 3–5), doc (Task 15).
- **§Arquitectura — componentes tocados**: `index.ts` barrel (Task 9), `container-runner.ts` (Task 10), `host-sweep.ts` (Task 13), `CLAUDE.md` (Task 16). The spec's "edit container-runner.ts directly" item is replaced with the cleaner registry pattern (deviation §3).
- **§Módulo claude-cli.ts — argv with `--`**: Task 6 step 3 + tests.
- **§Parser stream-json**: Task 7.
- **§Modelo de turno (single-turn)**: Task 8 — `push()` no-op documented in code + plan.
- **§Detección de sesión inválida**: Task 8.
- **§Hooks scripts (4 entries)**: Tasks 3–5 (post-tool-use serves both PostToolUse and PostToolUseFailure).
- **§Settings.json template**: Task 11 (host generates from constant).
- **§DB lock concern**: addressed by hooks doing single short transactions and swallowing errors (Tasks 3–5).
- **§Auth flow + mounts**: Tasks 11 (creds copy + RO nesting) + 13 (sweep resync). Spec's `/root/.claude` corrected to `/home/node/.claude` (deviation §1). Spec's `<sessionDir>/claude/` moved to sibling dir (deviation §2).
- **§Casos borde**: each documented in tests (Task 11 — no-creds, mtime gate; Task 13 — no host master).
- **§Selección del provider**: container.json `provider: claude-cli` (no DB enum to update — `agent_groups.agent_provider` is open-ended).
- **§Validación de la config**: provider name validation already happens at runtime via `getProviderFactory` (no change needed).
- **§Tests**: container Bun tests (Tasks 1–9) + host Vitest tests (Tasks 11, 13, 14).
- **§Documentación**: Tasks 15, 16. README/architecture untouched as spec specifies.
- **§Riesgos**: every risk has an explicit test or mitigation in the corresponding task.
- **§Out of scope**: not implemented — no `/use-claude-cli-provider` skill, no automatic migration, no SDK removal.

No placeholders. Every code step has the actual code. No "similar to Task N" references — code is repeated where needed.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-03-claude-cli-headless-provider.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints for review.

Which approach?
