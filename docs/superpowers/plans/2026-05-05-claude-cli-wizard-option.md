# Claude CLI Wizard Option Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose `claude-cli` as a fourth option in the setup wizard's auth menu, persist the choice as a global default in `.env`, and propagate it to every new agent group's `container.json`.

**Architecture:** Three small, focused changes. (1) `setup/auto.ts` grows a fourth menu entry, a verify-only `runHostCliAuth()` branch, and a paired idempotency guard. (2) Two scripts (`init-cli-agent.ts`, `init-first-agent.ts`) read `NANOCLAW_DEFAULT_PROVIDER` and apply it to the new group's `container.json` via the existing `updateContainerConfig()` helper. (3) Docs note the new path. The `claude-cli` provider itself is already built-in and self-registered — nothing in `src/providers/` changes.

**Tech Stack:** TypeScript, Node + pnpm, vitest, clack (`@clack/prompts`), existing `setup/lib/runner.ts` helpers (`fail`, `runQuietStep`).

---

## Reference: Files to create / modify

**Create (tests):**
- `setup/auto.test.ts` — vitest tests for `readEnvLine` + `checkCommandExists` exported helpers.
- `scripts/apply-default-provider.test.ts` — vitest test for the shared helper.

**Create (impl):**
- `scripts/lib/apply-default-provider.ts` — small shared helper used by both bootstrap scripts.

**Modify:**
- `setup/auto.ts` — exported `readEnvLine`; exported `checkCommandExists`; new `runHostCliAuth()`; fourth `brightSelect` option `'cli'`; new idempotency guard; switch update.
- `scripts/init-cli-agent.ts` — call `applyDefaultProvider(folder)` after `initGroupFilesystem`.
- `scripts/init-first-agent.ts` — same.
- `docs/claude-cli-provider.md` — short "Activate via setup wizard" section.
- `CLAUDE.md` — one bullet under built-in providers noting the wizard option.

---

## Conventions

- Bash commands: one per Bash call, no `&&` / heredocs / redirections (per CLAUDE.md global instructions).
- Commit messages: prefix style from recent history (`feat(setup): …`, `test(setup): …`, `docs(setup): …`).

---

## Task 1: Export `readEnvLine` helper

**Files:**
- Modify: `setup/auto.ts:896-904` (add `readEnvLine` next to existing `writeEnvLine`; mark both as `export`)
- Test: `setup/auto.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `setup/auto.test.ts`:

```ts
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readEnvLine } from './auto.js';

describe('readEnvLine', () => {
  let tmp: string;
  let prevCwd: string;

  beforeEach(() => {
    prevCwd = process.cwd();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-readenv-'));
    process.chdir(tmp);
  });

  afterEach(() => {
    process.chdir(prevCwd);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('returns null when .env is missing', () => {
    expect(readEnvLine('FOO')).toBeNull();
  });

  it('returns null when the key is absent', () => {
    fs.writeFileSync(path.join(tmp, '.env'), 'OTHER=1\n');
    expect(readEnvLine('FOO')).toBeNull();
  });

  it('returns the value when the key is present', () => {
    fs.writeFileSync(path.join(tmp, '.env'), 'FOO=bar\nBAZ=qux\n');
    expect(readEnvLine('FOO')).toBe('bar');
  });

  it('returns the last occurrence when the key is duplicated', () => {
    fs.writeFileSync(path.join(tmp, '.env'), 'FOO=first\nFOO=second\n');
    expect(readEnvLine('FOO')).toBe('second');
  });

  it('trims trailing whitespace from the value', () => {
    fs.writeFileSync(path.join(tmp, '.env'), 'FOO=bar   \n');
    expect(readEnvLine('FOO')).toBe('bar');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```
pnpm exec vitest run setup/auto.test.ts
```

Expected: FAIL with "readEnvLine is not exported" or similar.

- [ ] **Step 3: Add the helper and export it**

In `setup/auto.ts`, modify the existing `writeEnvLine` declaration to be exported and add `readEnvLine` right after it:

```ts
export function writeEnvLine(key: string, value: string): void {
  const envFile = path.join(process.cwd(), '.env');
  const content = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf-8') : '';
  const re = new RegExp(`^${key}=.*$`, 'm');
  const next = re.test(content)
    ? content.replace(re, `${key}=${value}`)
    : content.trimEnd() + (content ? '\n' : '') + `${key}=${value}\n`;
  fs.writeFileSync(envFile, next);
}

export function readEnvLine(key: string): string | null {
  const envFile = path.join(process.cwd(), '.env');
  if (!fs.existsSync(envFile)) return null;
  const content = fs.readFileSync(envFile, 'utf-8');
  const re = new RegExp(`^${key}=(.*)$`, 'gm');
  let match: RegExpExecArray | null;
  let last: string | null = null;
  while ((match = re.exec(content)) !== null) {
    last = match[1].trimEnd();
  }
  return last;
}
```

- [ ] **Step 4: Run test to verify it passes**

```
pnpm exec vitest run setup/auto.test.ts
```

Expected: PASS (5/5).

- [ ] **Step 5: Commit**

```
git add setup/auto.ts setup/auto.test.ts
```

```
git commit -m "test(setup): add readEnvLine helper for .env idempotency checks"
```

---

## Task 2: Add `checkCommandExists` helper

**Files:**
- Modify: `setup/auto.ts` (add new exported helper near `writeEnvLine`)
- Test: `setup/auto.test.ts` (extend)

- [ ] **Step 1: Add the failing tests**

Append to `setup/auto.test.ts`:

```ts
import { checkCommandExists } from './auto.js';

describe('checkCommandExists', () => {
  it('returns true for a binary that exists on PATH (node)', () => {
    expect(checkCommandExists('node')).toBe(true);
  });

  it('returns false for a binary that does not exist', () => {
    expect(checkCommandExists('nanoclaw-no-such-binary-xyz123')).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```
pnpm exec vitest run setup/auto.test.ts
```

Expected: FAIL with "checkCommandExists is not exported".

- [ ] **Step 3: Implement the helper**

Add to `setup/auto.ts` near the env-line helpers:

```ts
import { spawnSync } from 'child_process';

export function checkCommandExists(name: string): boolean {
  // `command -v` is a POSIX shell builtin; sh -c is portable across mac/linux.
  // Caller is trusted (constant binary names from setup), no injection risk.
  const result = spawnSync('sh', ['-c', `command -v ${name}`], { stdio: 'ignore' });
  return result.status === 0;
}
```

(If `spawnSync` is already imported elsewhere in the file, dedupe — don't duplicate the import.)

- [ ] **Step 4: Run tests to verify they pass**

```
pnpm exec vitest run setup/auto.test.ts
```

Expected: PASS (7/7).

- [ ] **Step 5: Commit**

```
git add setup/auto.ts setup/auto.test.ts
```

```
git commit -m "test(setup): add checkCommandExists helper for host binary verification"
```

---

## Task 3: Add fourth option `'cli'` to the auth menu

**Files:**
- Modify: `setup/auto.ts:713-743` (the `runAuthStep` `brightSelect` block)

No test step — this is a UI wiring change verified by manual run + typecheck.

- [ ] **Step 1: Update the option list and type union**

In `runAuthStep` (`setup/auto.ts:713-734`), change the `brightSelect` to four options and the `as` cast to four members:

```ts
const method = ensureAnswer(
  await brightSelect({
    message: 'How would you like to connect to Claude?',
    options: [
      {
        value: 'subscription',
        label: 'Sign in with my Claude subscription',
        hint: 'recommended if you have Pro or Max',
      },
      {
        value: 'cli',
        label: 'Use my host Claude Code CLI session',
        hint: 'OAuth-only, no proxy — requires `claude /login` on the host',
      },
      {
        value: 'oauth',
        label: 'Paste an OAuth token I already have',
        hint: 'sk-ant-oat…',
      },
      {
        value: 'api',
        label: 'Paste an Anthropic API key',
        hint: 'pay-per-use via console.anthropic.com',
      },
    ],
  }),
) as 'subscription' | 'cli' | 'oauth' | 'api';
setupLog.userInput('auth_method', method);
phEmit('auth_method_chosen', { method });
```

- [ ] **Step 2: Update the dispatch switch**

Replace the `if (method === 'subscription') … else …` block (auto.ts:738-742) with:

```ts
if (method === 'subscription') {
  await runSubscriptionAuth();
} else if (method === 'cli') {
  await runHostCliAuth();
} else {
  await runPasteAuth(method);
}
```

`runHostCliAuth` is implemented in Task 4. Compilation will fail until Task 4 lands — that's expected; this task and Task 4 commit together at Task 4's commit step.

- [ ] **Step 3: Verify typecheck still progresses (will fail on missing function)**

```
pnpm exec tsc --noEmit
```

Expected: FAIL with "Cannot find name 'runHostCliAuth'". This is the bridge to Task 4.

- [ ] **Step 4: Do not commit yet**

Combined commit at end of Task 4.

---

## Task 4: Implement `runHostCliAuth` (verify-only path)

**Files:**
- Modify: `setup/auto.ts` (add new function near `runSubscriptionAuth` / `runPasteAuth`)

- [ ] **Step 1: Add the function**

Add to `setup/auto.ts` after `runPasteAuth` (or wherever auth helpers cluster):

```ts
async function runHostCliAuth(): Promise<void> {
  const start = Date.now();

  if (!checkCommandExists('claude')) {
    setupLog.step('auth', 'failed', Date.now() - start, {
      METHOD: 'cli',
      REASON: 'cli-not-installed',
    });
    await fail(
      'auth',
      'Claude Code CLI not found on PATH.',
      'Install it from https://claude.ai/install.sh, run `claude /login`, then re-run setup.',
    );
  }

  const credsPath = path.join(os.homedir(), '.claude', '.credentials.json');
  if (!fs.existsSync(credsPath)) {
    setupLog.step('auth', 'failed', Date.now() - start, {
      METHOD: 'cli',
      REASON: 'host-not-logged-in',
    });
    await fail(
      'auth',
      'No host Claude login found.',
      'Run `claude /login` on the host first, then re-run setup.',
    );
  }

  writeEnvLine('NANOCLAW_DEFAULT_PROVIDER', 'claude-cli');

  setupLog.step('auth', 'success', Date.now() - start, { METHOD: 'cli' });
  p.log.success(brandBody('Host Claude CLI session detected.'));
}
```

If `os` is not yet imported in this file, add `import os from 'os';` to the top imports (next to the existing `fs` and `path` imports).

- [ ] **Step 2: Run typecheck**

```
pnpm exec tsc --noEmit
```

Expected: PASS.

- [ ] **Step 3: Run host tests**

```
pnpm exec vitest run
```

Expected: PASS (existing tests + the 7 from Tasks 1-2).

- [ ] **Step 4: Commit Tasks 3 + 4 together**

```
git add setup/auto.ts
```

```
git commit -m "feat(setup): add claude-cli option to wizard auth menu"
```

---

## Task 5: Add idempotency guard for re-runs

**Files:**
- Modify: `setup/auto.ts:696-701` (the `runAuthStep` head)

No test — this is wiring of two existing helpers (`readEnvLine`, `fs.existsSync`).

- [ ] **Step 1: Add the second guard**

In `runAuthStep`, after the existing `anthropicSecretExists()` block (auto.ts:697-701) and before the custom-endpoint branch (auto.ts:706), add:

```ts
const cliEnv = readEnvLine('NANOCLAW_DEFAULT_PROVIDER');
const cliCreds = fs.existsSync(path.join(os.homedir(), '.claude', '.credentials.json'));
if (cliEnv === 'claude-cli' && cliCreds) {
  p.log.success(brandBody('Host Claude CLI session detected.'));
  setupLog.step('auth', 'skipped', 0, { REASON: 'cli-already-configured' });
  return;
}
```

The order matters: this runs **after** `anthropicSecretExists()` so a SDK install that's also running `claude` on the side doesn't get bumped into the CLI path.

- [ ] **Step 2: Run typecheck**

```
pnpm exec tsc --noEmit
```

Expected: PASS.

- [ ] **Step 3: Commit**

```
git add setup/auto.ts
```

```
git commit -m "feat(setup): skip auth step when claude-cli is already configured"
```

---

## Task 6: Shared helper `applyDefaultProvider`

**Files:**
- Create: `scripts/lib/apply-default-provider.ts`
- Test: `scripts/apply-default-provider.test.ts`

- [ ] **Step 1: Write the failing test**

`GROUPS_DIR` is computed once from `process.cwd()` when `src/config.ts` first loads, so we can't redirect it via env var or chdir from the test. Instead we mock `updateContainerConfig` (the only side effect of the helper) and assert on what it would have been called with.

Create `scripts/apply-default-provider.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const updateContainerConfig = vi.fn();

vi.mock('../src/container-config.js', () => ({
  updateContainerConfig,
}));

import { applyDefaultProvider } from './lib/apply-default-provider.js';

describe('applyDefaultProvider', () => {
  beforeEach(() => {
    updateContainerConfig.mockReset();
  });

  afterEach(() => {
    delete process.env.NANOCLAW_DEFAULT_PROVIDER;
  });

  it('writes the provider field when NANOCLAW_DEFAULT_PROVIDER is set', () => {
    process.env.NANOCLAW_DEFAULT_PROVIDER = 'claude-cli';
    applyDefaultProvider('some-group');

    expect(updateContainerConfig).toHaveBeenCalledTimes(1);
    expect(updateContainerConfig.mock.calls[0][0]).toBe('some-group');

    // Apply the mutator on a stub config and verify the field is set.
    const mutator = updateContainerConfig.mock.calls[0][1] as (c: { provider?: string }) => void;
    const stub: { provider?: string } = {};
    mutator(stub);
    expect(stub.provider).toBe('claude-cli');
  });

  it('is a no-op when NANOCLAW_DEFAULT_PROVIDER is unset', () => {
    applyDefaultProvider('some-group');
    expect(updateContainerConfig).not.toHaveBeenCalled();
  });

  it('is a no-op when NANOCLAW_DEFAULT_PROVIDER is empty string', () => {
    process.env.NANOCLAW_DEFAULT_PROVIDER = '';
    applyDefaultProvider('some-group');
    expect(updateContainerConfig).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```
pnpm exec vitest run scripts/apply-default-provider.test.ts
```

Expected: FAIL with "Cannot find module './lib/apply-default-provider.js'".

- [ ] **Step 3: Implement the helper**

Create `scripts/lib/apply-default-provider.ts`:

```ts
import { updateContainerConfig } from '../../src/container-config.js';

/**
 * If NANOCLAW_DEFAULT_PROVIDER is set in the environment, write it to the
 * group's container.json `provider` field. No-op otherwise — leaves the
 * field unset so the runner falls back to its code default ("claude" SDK).
 *
 * Called from init-cli-agent.ts and init-first-agent.ts after each fresh
 * group is bootstrapped via initGroupFilesystem().
 */
export function applyDefaultProvider(folder: string): void {
  const provider = process.env.NANOCLAW_DEFAULT_PROVIDER;
  if (!provider) return;
  updateContainerConfig(folder, (c) => {
    c.provider = provider;
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

```
pnpm exec vitest run scripts/apply-default-provider.test.ts
```

Expected: PASS (3/3).

- [ ] **Step 5: Commit**

```
git add scripts/lib/apply-default-provider.ts scripts/apply-default-provider.test.ts
```

```
git commit -m "feat(scripts): add applyDefaultProvider helper for container.json"
```

---

## Task 7: Wire `applyDefaultProvider` into `init-cli-agent.ts`

**Files:**
- Modify: `scripts/init-cli-agent.ts:120` (after `initGroupFilesystem(ag, …)` call)

No test — covered by Task 6's helper test. End-to-end is verified manually via the wizard.

- [ ] **Step 1: Add the import and call**

At the top of `scripts/init-cli-agent.ts`, add the import (next to other relative imports like `../src/group-init.js`):

```ts
import { applyDefaultProvider } from './lib/apply-default-provider.js';
```

Then immediately after the `initGroupFilesystem(ag, { … })` call (around line 120-125), add:

```ts
applyDefaultProvider(ag.folder);
```

- [ ] **Step 2: Run typecheck**

```
pnpm exec tsc --noEmit
```

Expected: PASS.

- [ ] **Step 3: Smoke-run the script with env var set**

Use a throwaway folder name to avoid clobbering real state:

```
NANOCLAW_DEFAULT_PROVIDER=claude-cli pnpm exec tsx scripts/init-cli-agent.ts --display-name "PlanTest" --agent-name "PlanTestAgent" --folder _plan-test-cli
```

Then:

```
cat groups/_plan-test-cli/container.json
```

Expected: JSON output contains `"provider": "claude-cli"`.

Cleanup (do NOT skip):

```
pnpm exec tsx scripts/delete-cli-agent.ts --folder _plan-test-cli
```

(If that script doesn't accept `--folder` or doesn't exist, manually `rm -rf groups/_plan-test-cli` and remove the corresponding rows via the operator's normal cleanup path.)

- [ ] **Step 4: Commit**

```
git add scripts/init-cli-agent.ts
```

```
git commit -m "feat(scripts): apply NANOCLAW_DEFAULT_PROVIDER in init-cli-agent"
```

---

## Task 8: Wire `applyDefaultProvider` into `init-first-agent.ts`

**Files:**
- Modify: `scripts/init-first-agent.ts` (after the script's `initGroupFilesystem` call)

- [ ] **Step 1: Locate the right spot**

```
grep -n "initGroupFilesystem" scripts/init-first-agent.ts
```

Expected: one or more matches. Add the call **right after** the bootstrap-time `initGroupFilesystem(ag, …)` invocation (the one that creates a new group, not any idempotent reuse path that already passed earlier).

- [ ] **Step 2: Add the import**

Add to the top imports of `scripts/init-first-agent.ts`:

```ts
import { applyDefaultProvider } from './lib/apply-default-provider.js';
```

- [ ] **Step 3: Add the call**

Immediately after the `initGroupFilesystem(ag, { … })` line in the bootstrap path:

```ts
applyDefaultProvider(ag.folder);
```

- [ ] **Step 4: Run typecheck**

```
pnpm exec tsc --noEmit
```

Expected: PASS.

- [ ] **Step 5: Commit**

```
git add scripts/init-first-agent.ts
```

```
git commit -m "feat(scripts): apply NANOCLAW_DEFAULT_PROVIDER in init-first-agent"
```

---

## Task 9: Doc update — `docs/claude-cli-provider.md`

**Files:**
- Modify: `docs/claude-cli-provider.md` (add a new section after the "Activate for a group" section)

- [ ] **Step 1: Add wizard activation section**

In `docs/claude-cli-provider.md`, find the existing `## Activate for a group` heading. Add a new section **before** it titled `## Activate via setup wizard`:

```markdown
## Activate via setup wizard

When you run `bash nanoclaw.sh`, the auth menu offers four options. Choose
**"Use my host Claude Code CLI session"** to make `claude-cli` the default
provider for every new agent group on this install. The wizard verifies
that `claude` is on PATH and that `~/.claude/.credentials.json` exists; if
either is missing, it fails with a clear message and you fix it on the host
(`https://claude.ai/install.sh` to install, then `claude /login`) and re-run.

The wizard sets `NANOCLAW_DEFAULT_PROVIDER=claude-cli` in `.env`.
`scripts/init-cli-agent.ts` and `scripts/init-first-agent.ts` read that
variable and write `"provider": "claude-cli"` into each new group's
`container.json`. Existing groups are not modified.

To switch a single group back to the SDK provider, edit
`groups/<folder>/container.json` and remove the `provider` field (or set it
to `"claude"`).
```

- [ ] **Step 2: Verify it renders cleanly**

```
grep -n "Activate via setup wizard" docs/claude-cli-provider.md
```

Expected: matches the new heading line.

- [ ] **Step 3: Commit**

```
git add docs/claude-cli-provider.md
```

```
git commit -m "docs(claude-cli): document wizard activation path"
```

---

## Task 10: Doc update — `CLAUDE.md`

**Files:**
- Modify: `CLAUDE.md` (the "Built-in providers" bullet list)

- [ ] **Step 1: Locate the existing block**

```
grep -n "Built-in providers" CLAUDE.md
```

Expected: one match. The block lists `claude` (SDK) and `claude-cli`.

- [ ] **Step 2: Append a one-liner about wizard selection**

Modify the `claude-cli` bullet so it reads (replacing the existing line):

```markdown
- `claude-cli` — invokes `/pnpm/claude -p` in headless mode using the host's `claude /login` OAuth session. Selectable from the setup wizard's auth menu (sets `NANOCLAW_DEFAULT_PROVIDER=claude-cli`); otherwise opt-in per group via `container.json`. See [docs/claude-cli-provider.md](docs/claude-cli-provider.md).
```

- [ ] **Step 3: Commit**

```
git add CLAUDE.md
```

```
git commit -m "docs: note wizard option for claude-cli in CLAUDE.md"
```

---

## Task 11: Final verification

**Files:** none (read-only checks).

- [ ] **Step 1: Run pre-PR checklist**

```
pnpm run format:check
```

Expected: clean (no files would be reformatted).

```
pnpm exec tsc --noEmit
```

Expected: 0 errors.

```
pnpm exec vitest run
```

Expected: all tests pass, including the new ones from Tasks 1, 2, and 6.

- [ ] **Step 2: Manual wizard sanity check**

Stop the running NanoClaw service so the wizard's environment probe doesn't conflict:

```
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
```

(Linux: `systemctl --user stop nanoclaw`.)

In a separate terminal — NOT inside Claude Code — the operator runs:

```
bash nanoclaw.sh
```

Confirm:
1. The auth menu shows **four** options, with the new entry "Use my host Claude Code CLI session" between subscription and paste-OAuth.
2. Selecting `cli` on a host **without** `claude /login` produces the "No host Claude login found" failure with the suggested remediation.
3. Selecting `cli` on a host **with** `claude /login` writes `NANOCLAW_DEFAULT_PROVIDER=claude-cli` to `.env` and continues setup.
4. The created `_ping-test` group's `groups/_ping-test/container.json` contains `"provider": "claude-cli"`.

> **Note:** the agent **must be Claude himself** explicitly delegating this manual run to the user; Claude cannot run the interactive wizard from inside Claude Code. State this clearly when handing off.

- [ ] **Step 3: Re-load the service**

```
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
```

(Linux: `systemctl --user start nanoclaw`.)

- [ ] **Step 4: No commit needed for verification**

This task only verifies. If any step fails, return to the corresponding earlier task to fix and re-test.

---

## Self-review notes

- **Spec coverage:** sections 1 (UX) → Tasks 3+4; section 2 (persistence) → Tasks 1, 5, 6, 7, 8; section 3 (touch points) → Tasks 1-10; section 4 (edge cases): the verify-only behavior of Task 4 covers (a); idempotency Task 5 covers (c); per-group override is documented in Task 9; custom-endpoint left untouched (e); single-turn provider compatibility (f) is implicit (no code change needed); skills compatibility (g) is doc-only and out of scope, mentioned in Task 9.
- **Type consistency:** the helper is named `applyDefaultProvider` in Tasks 6, 7, 8. The auth method value `'cli'` is used consistently in Tasks 3 and 4. `NANOCLAW_DEFAULT_PROVIDER` is the env var name in every task that touches it.
- **No placeholders:** every code block is concrete.
- **Notable risk:** Task 6 mocks `updateContainerConfig` rather than touching real files. End-to-end propagation (env var → real `container.json`) is verified by the smoke run in Task 7 Step 3 and the manual wizard check in Task 11 Step 2.
