import { describe, expect, it } from 'bun:test';

import { SDK_DISALLOWED_TOOLS, TOOL_ALLOWLIST } from './tool-policies.js';

describe('tool-policies', () => {
  it('exports the same denylist the SDK provider used inline', () => {
    expect(SDK_DISALLOWED_TOOLS).toEqual([
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
    expect(Object.isFrozen(SDK_DISALLOWED_TOOLS)).toBe(true);
    expect(Object.isFrozen(TOOL_ALLOWLIST)).toBe(true);
  });
});
