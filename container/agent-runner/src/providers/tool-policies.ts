/**
 * Tool policy constants shared by built-in Claude providers (SDK + CLI).
 *
 * Extracted from claude.ts so both providers stay in lockstep — adding a
 * disallowed tool here patches the SDK provider's `disallowedTools` list and
 * the CLI provider's `--disallowedTools` argv simultaneously.
 */

/**
 * Tools that either sidestep nanoclaw's own scheduling or don't fit our
 * async message-passing model (they're designed for Claude Code's
 * interactive UI and would hang here). Shared by both built-in providers
 * (`claude` SDK + `claude-cli` headless).
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
