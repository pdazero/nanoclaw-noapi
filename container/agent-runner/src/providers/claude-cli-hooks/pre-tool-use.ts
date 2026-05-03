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
