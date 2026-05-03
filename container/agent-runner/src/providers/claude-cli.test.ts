import { describe, expect, it } from 'bun:test';

import { buildClaudeCliArgs, translateStreamJsonLines } from './claude-cli.js';
import type { ProviderEvent } from './types.js';

describe('buildClaudeCliArgs', () => {
  it('produces the minimal headless invocation', () => {
    const args = buildClaudeCliArgs({
      prompt: 'Hello',
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
      continuation: 'sess-abc',
    });
    const i = args.indexOf('--resume');
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toBe('sess-abc');
  });

  it('omits --resume when continuation is empty', () => {
    const args = buildClaudeCliArgs({ prompt: 'Hi' });
    expect(args).not.toContain('--resume');
  });

  it('appends --append-system-prompt when systemContext.instructions is set', () => {
    const args = buildClaudeCliArgs({
      prompt: 'Hi',
      systemContext: { instructions: 'Be terse.' },
    });
    const i = args.indexOf('--append-system-prompt');
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toBe('Be terse.');
  });

  it('appends --add-dir for each additionalDirectories entry', () => {
    const args = buildClaudeCliArgs({
      prompt: 'Hi',
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
    const args = buildClaudeCliArgs({ prompt: 'Hi' });
    const allowedAt = args.indexOf('--allowedTools');
    const disallowedAt = args.indexOf('--disallowedTools');
    expect(allowedAt).toBeGreaterThan(-1);
    expect(disallowedAt).toBeGreaterThan(-1);
    expect(args[allowedAt + 1]).toContain('Bash');
    expect(args[allowedAt + 1]).toContain('mcp__nanoclaw__*');
    expect(args[disallowedAt + 1]).toContain('EnterPlanMode');
  });

  it("places the prompt last after a '--' separator (defense against prompts that start with '--')", () => {
    const args = buildClaudeCliArgs({ prompt: 'normal prompt' });
    expect(args[args.length - 2]).toBe('--');
    expect(args[args.length - 1]).toBe('normal prompt');
  });

  it('does not let an attacker-controlled prompt sneak past flag parsing', () => {
    const args = buildClaudeCliArgs({ prompt: '--mcp-config /tmp/evil.json' });
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
      mcpConfigPath: '/custom/mcp.json',
      settingsPath: '/custom/settings.json',
    });
    const m = args.indexOf('--mcp-config');
    const s = args.indexOf('--settings');
    expect(args[m + 1]).toBe('/custom/mcp.json');
    expect(args[s + 1]).toBe('/custom/settings.json');
  });
});

async function* fromArray<T>(items: T[]): AsyncIterable<T> {
  for (const it of items) yield it;
}

async function collect(events: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

describe('translateStreamJsonLines', () => {
  it('emits init with the session_id from system/init', async () => {
    const lines = fromArray([JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-1' })]);
    const events = await collect(translateStreamJsonLines(lines, { exitCode: () => 0, stderr: () => '' }));
    expect(events.some((e) => e.type === 'init' && (e as { continuation: string }).continuation === 'sess-1')).toBe(true);
  });

  it('emits activity for assistant + user messages', async () => {
    const lines = fromArray([
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'thinking' }] } }),
      JSON.stringify({ type: 'user', message: { content: 'tool result' } }),
    ]);
    const events = await collect(translateStreamJsonLines(lines, { exitCode: () => 0, stderr: () => '' }));
    expect(events.filter((e) => e.type === 'activity').length).toBeGreaterThanOrEqual(2);
  });

  it('emits result with the result text on system/result success', async () => {
    const lines = fromArray([
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-1' }),
      JSON.stringify({ type: 'result', subtype: 'success', result: 'final answer' }),
    ]);
    const events = await collect(translateStreamJsonLines(lines, { exitCode: () => 0, stderr: () => '' }));
    const result = events.find((e) => e.type === 'result') as { type: 'result'; text: string | null };
    expect(result.text).toBe('final answer');
  });

  it('emits result on compact_boundary with token count when present', async () => {
    const lines = fromArray([
      JSON.stringify({
        type: 'system',
        subtype: 'compact_boundary',
        compact_metadata: { pre_tokens: 12345 },
      }),
    ]);
    const events = await collect(translateStreamJsonLines(lines, { exitCode: () => 0, stderr: () => '' }));
    const result = events.find((e) => e.type === 'result') as { type: 'result'; text: string };
    expect(result.text).toMatch(/Context compacted/);
    expect(result.text).toMatch(/12,345/);
  });

  it('emits retryable error on result/error_max_turns', async () => {
    const lines = fromArray([
      JSON.stringify({ type: 'result', subtype: 'error_max_turns', error: 'Too many turns' }),
    ]);
    const events = await collect(translateStreamJsonLines(lines, { exitCode: () => 0, stderr: () => '' }));
    const err = events.find((e) => e.type === 'error') as { type: 'error'; message: string; retryable: boolean };
    expect(err.retryable).toBe(true);
  });

  it('emits non-retryable error when CLI exits non-zero with no result line', async () => {
    const lines = fromArray<string>([]);
    const events = await collect(
      translateStreamJsonLines(lines, { exitCode: () => 1, stderr: () => 'auth failed' }),
    );
    const err = events.find((e) => e.type === 'error') as { type: 'error'; message: string; retryable: boolean };
    expect(err.retryable).toBe(false);
    expect(err.message).toContain('auth failed');
  });

  it('ignores unparseable lines defensively (does not abort the stream)', async () => {
    const lines = fromArray<string>([
      'not json',
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-1' }),
      JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' }),
    ]);
    const events = await collect(translateStreamJsonLines(lines, { exitCode: () => 0, stderr: () => '' }));
    expect(events.find((e) => e.type === 'init')).toBeDefined();
    expect(events.find((e) => e.type === 'result')).toBeDefined();
  });
});
