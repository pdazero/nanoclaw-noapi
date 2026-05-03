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
    expect(TOOL_ALLOWLIST).toEqual([
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
  });

  it('arrays are frozen so callers cannot mutate them', () => {
    expect(Object.isFrozen(DISALLOWED_TOOLS)).toBe(true);
    expect(Object.isFrozen(TOOL_ALLOWLIST)).toBe(true);
  });
});
