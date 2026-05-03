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
