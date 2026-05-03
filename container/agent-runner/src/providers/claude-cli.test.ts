import { describe, expect, it } from 'bun:test';

import { buildClaudeCliArgs } from './claude-cli.js';

describe('buildClaudeCliArgs', () => {
  it('produces the minimal headless invocation', () => {
    const args = buildClaudeCliArgs({
      prompt: 'Hello',
      cwd: '/workspace/agent',
    });
    expect(args[0]).toBe('-p');
    expect(args).toContain('--output-format');
    expect(args).toContain('stream-json');
    expect(args).toContain('--verbose');
    expect(args).toContain('--permission-mode');
    expect(args).toContain('bypassPermissions');
    expect(args).toContain('--dangerously-skip-permissions');
    expect(args).toContain('--mcp-config');
    expect(args).toContain('--settings');
  });

  it('appends --resume <id> when continuation is set', () => {
    const args = buildClaudeCliArgs({
      prompt: 'Hi',
      cwd: '/workspace/agent',
      continuation: 'sess-abc',
    });
    const i = args.indexOf('--resume');
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toBe('sess-abc');
  });

  it('omits --resume when continuation is empty', () => {
    const args = buildClaudeCliArgs({ prompt: 'Hi', cwd: '/workspace/agent' });
    expect(args).not.toContain('--resume');
  });

  it('appends --append-system-prompt when systemContext.instructions is set', () => {
    const args = buildClaudeCliArgs({
      prompt: 'Hi',
      cwd: '/workspace/agent',
      systemContext: { instructions: 'Be terse.' },
    });
    const i = args.indexOf('--append-system-prompt');
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toBe('Be terse.');
  });

  it('appends --add-dir for each additionalDirectories entry', () => {
    const args = buildClaudeCliArgs({
      prompt: 'Hi',
      cwd: '/workspace/agent',
      additionalDirectories: ['/workspace/extra/a', '/workspace/extra/b'],
    });
    const positions = args
      .map((a, idx) => (a === '--add-dir' ? idx : -1))
      .filter((idx) => idx !== -1);
    expect(positions.length).toBe(2);
    expect(args[positions[0] + 1]).toBe('/workspace/extra/a');
    expect(args[positions[1] + 1]).toBe('/workspace/extra/b');
  });

  it('serializes allowed/disallowed tools as comma-separated strings', () => {
    const args = buildClaudeCliArgs({ prompt: 'Hi', cwd: '/workspace/agent' });
    const allowedAt = args.indexOf('--allowedTools');
    const disallowedAt = args.indexOf('--disallowedTools');
    expect(allowedAt).toBeGreaterThan(-1);
    expect(disallowedAt).toBeGreaterThan(-1);
    expect(args[allowedAt + 1]).toContain('Bash');
    expect(args[allowedAt + 1]).toContain('mcp__nanoclaw__*');
    expect(args[disallowedAt + 1]).toContain('EnterPlanMode');
  });

  it("places the prompt last after a '--' separator (defense against prompts that start with '--')", () => {
    const args = buildClaudeCliArgs({ prompt: 'normal prompt', cwd: '/workspace/agent' });
    expect(args[args.length - 2]).toBe('--');
    expect(args[args.length - 1]).toBe('normal prompt');
  });

  it('does not let an attacker-controlled prompt sneak past flag parsing', () => {
    const args = buildClaudeCliArgs({ prompt: '--mcp-config /tmp/evil.json', cwd: '/workspace/agent' });
    // The malicious prompt is the LAST element AFTER '--', so the CLI's argv
    // parser stops interpreting flags before it and the original
    // --mcp-config <legit> earlier in args wins.
    expect(args[args.length - 1]).toBe('--mcp-config /tmp/evil.json');
    const sepIdx = args.lastIndexOf('--');
    expect(sepIdx).toBe(args.length - 2);
  });

  it('respects custom mcpConfigPath and settingsPath', () => {
    const args = buildClaudeCliArgs({
      prompt: 'Hi',
      cwd: '/workspace/agent',
      mcpConfigPath: '/custom/mcp.json',
      settingsPath: '/custom/settings.json',
    });
    const m = args.indexOf('--mcp-config');
    const s = args.indexOf('--settings');
    expect(args[m + 1]).toBe('/custom/mcp.json');
    expect(args[s + 1]).toBe('/custom/settings.json');
  });
});
