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
