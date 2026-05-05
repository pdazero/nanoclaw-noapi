/**
 * Claude CLI provider — invokes /pnpm/claude in headless mode with
 * stream-json output, instead of going through the SDK. Auth uses the
 * host's OAuth login (no ANTHROPIC_API_KEY, no OneCLI proxy for the AI
 * traffic). Hook scripts on disk enforce the same denylist + container_state
 * tracking the SDK provider does in-process.
 *
 * Module structure:
 *   - `buildClaudeCliArgs` — pure argv builder.
 *   - `translateStreamJsonLines` + `ClaudeCliChildAdapter` — pure parser.
 *   - `ClaudeCliProvider` class — `Bun.spawn` lifecycle (spawn, drain,
 *     translate, abort, register). Implements `AgentProvider`.
 */
import { registerProvider } from './provider-registry.js';
import { DISALLOWED_TOOLS, TOOL_ALLOWLIST } from './tool-policies.js';
import type { AgentProvider, AgentQuery, ProviderEvent, ProviderOptions, QueryInput } from './types.js';

const DEFAULT_MCP_CONFIG_PATH = '/home/node/.claude/mcp.json';
const DEFAULT_SETTINGS_PATH = '/home/node/.claude/settings.json';

export interface BuildClaudeCliArgsInput {
  /** Initial prompt text. Always rendered as the LAST argv element after `--`. */
  prompt: string;
  /** Session id from a prior turn; if set, the CLI resumes via `--resume`. */
  continuation?: string;
  /** System instructions appended via `--append-system-prompt`. */
  systemContext?: { instructions?: string };
  /** Additional dirs the CLI is allowed to read; each becomes one `--add-dir`. */
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
  private env: Record<string, string | undefined>;
  private additionalDirectories?: string[];

  constructor(options: ProviderOptions = {}) {
    // options.mcpServers is intentionally ignored: the host generates
    // mcp.json and nested-RO-mounts it at /home/node/.claude/mcp.json,
    // which the CLI loads via the --mcp-config flag baked into argv.
    this.assistantName = options.assistantName;
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

    let child: ReturnType<typeof Bun.spawn> | null = null;
    let spawnError: Error | null = null;
    try {
      child = Bun.spawn([DEFAULT_CLAUDE_BIN, ...args], {
        cwd: input.cwd,
        env: childEnv,
        stdout: 'pipe',
        stderr: 'pipe',
      });
    } catch (err) {
      spawnError = err instanceof Error ? err : new Error(String(err));
      log(`spawn failed: ${spawnError.message}`);
    }

    let stderrBuf = '';
    if (child) {
      (async () => {
        const reader = child!.stderr;
        if (!reader) return;
        const decoder = new TextDecoder();
        // @ts-expect-error — async iterable
        for await (const chunk of reader) {
          stderrBuf += decoder.decode(chunk, { stream: true });
        }
      })().catch((err) => {
        log(`stderr drain error: ${err instanceof Error ? err.message : String(err)}`);
      });
    }

    const adapter = {
      exitCode: () => child?.exitCode ?? null,
      stderr: () => stderrBuf,
    };

    let aborted = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    const capturedSpawnError = spawnError;
    const capturedChild = child;

    const events = (async function* () {
      if (capturedSpawnError) {
        yield { type: 'error' as const, message: capturedSpawnError.message, retryable: false };
        return;
      }
      const stdout = capturedChild?.stdout;
      if (!stdout || typeof stdout === 'number') return;
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
        if (killTimer) {
          clearTimeout(killTimer);
          killTimer = null;
        }
        try {
          capturedChild?.kill('SIGTERM');
        } catch {
          /* already dead */
        }
      },
      abort: () => {
        aborted = true;
        try {
          capturedChild?.kill('SIGTERM');
        } catch {
          /* already dead */
        }
        killTimer = setTimeout(() => {
          killTimer = null;
          try {
            capturedChild?.kill('SIGKILL');
          } catch {
            /* already dead */
          }
        }, 5000);
      },
    };
  }
}

registerProvider('claude-cli', (opts) => new ClaudeCliProvider(opts));
