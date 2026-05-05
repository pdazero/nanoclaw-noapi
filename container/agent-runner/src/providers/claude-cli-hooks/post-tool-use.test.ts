import { describe, expect, it } from 'bun:test';

describe('post-tool-use hook', () => {
  it('exits 0 even when /workspace/outbound.db is unavailable (subprocess swallows DB errors)', async () => {
    // Run the hook in a subprocess: drives stdin and reads exit code without
    // polluting this test process. The hook tries to write to outbound.db,
    // which doesn't exist in this test environment; the catch block in the
    // hook must swallow the error and still exit 0 so the CLI is not blocked.
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
