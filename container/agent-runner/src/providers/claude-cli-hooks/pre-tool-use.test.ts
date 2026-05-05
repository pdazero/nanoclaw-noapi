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
