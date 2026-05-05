import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

const HOOK = new URL('./pre-compact.ts', import.meta.url).pathname;

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pre-compact-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function runHook(env: Record<string, string>, stdinJson: string): Promise<number> {
  const proc = Bun.spawn({
    cmd: ['bun', 'run', HOOK],
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ...env },
  });
  proc.stdin.write(stdinJson);
  proc.stdin.end();
  return await proc.exited;
}

describe('pre-compact hook', () => {
  it('writes a markdown transcript to {workspaceAgent}/conversations/', async () => {
    const transcript = path.join(tmpDir, 'session.jsonl');
    const workspaceAgent = path.join(tmpDir, 'workspace', 'agent');
    fs.mkdirSync(workspaceAgent, { recursive: true });
    fs.writeFileSync(
      transcript,
      [
        JSON.stringify({ type: 'user', message: { content: 'hi' } }),
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'yo' }] } }),
      ].join('\n'),
    );

    const exit = await runHook(
      { NANOCLAW_CONVERSATIONS_DIR: path.join(workspaceAgent, 'conversations'), NANOCLAW_ASSISTANT_NAME: 'Nano' },
      JSON.stringify({ transcript_path: transcript, session_id: 'abc' }),
    );
    expect(exit).toBe(0);

    const files = fs.readdirSync(path.join(workspaceAgent, 'conversations'));
    expect(files.length).toBe(1);
    const md = fs.readFileSync(path.join(workspaceAgent, 'conversations', files[0]), 'utf-8');
    expect(md).toContain('**User**: hi');
    expect(md).toContain('**Nano**: yo');
  });

  it('is a no-op when transcript_path is missing', async () => {
    const workspaceAgent = path.join(tmpDir, 'workspace', 'agent');
    fs.mkdirSync(workspaceAgent, { recursive: true });
    const exit = await runHook(
      { NANOCLAW_CONVERSATIONS_DIR: path.join(workspaceAgent, 'conversations') },
      JSON.stringify({}),
    );
    expect(exit).toBe(0);
    expect(fs.existsSync(path.join(workspaceAgent, 'conversations'))).toBe(false);
  });

  it('is a no-op when transcript file is empty (no parsed messages)', async () => {
    const transcript = path.join(tmpDir, 'session.jsonl');
    const workspaceAgent = path.join(tmpDir, 'workspace', 'agent');
    fs.mkdirSync(workspaceAgent, { recursive: true });
    fs.writeFileSync(transcript, '');
    const exit = await runHook(
      { NANOCLAW_CONVERSATIONS_DIR: path.join(workspaceAgent, 'conversations') },
      JSON.stringify({ transcript_path: transcript, session_id: 'abc' }),
    );
    expect(exit).toBe(0);
    const dir = path.join(workspaceAgent, 'conversations');
    expect(!fs.existsSync(dir) || fs.readdirSync(dir).length === 0).toBe(true);
  });

  it('uses the summary from sessions-index.json when available', async () => {
    const dir = path.join(tmpDir, 'projects');
    fs.mkdirSync(dir, { recursive: true });
    const transcript = path.join(dir, 'session.jsonl');
    fs.writeFileSync(transcript, JSON.stringify({ type: 'user', message: { content: 'hi' } }));
    fs.writeFileSync(
      path.join(dir, 'sessions-index.json'),
      JSON.stringify({ entries: [{ sessionId: 'abc', summary: 'Refactor Plan' }] }),
    );
    const workspaceAgent = path.join(tmpDir, 'workspace', 'agent');
    fs.mkdirSync(workspaceAgent, { recursive: true });

    await runHook(
      { NANOCLAW_CONVERSATIONS_DIR: path.join(workspaceAgent, 'conversations') },
      JSON.stringify({ transcript_path: transcript, session_id: 'abc' }),
    );

    const files = fs.readdirSync(path.join(workspaceAgent, 'conversations'));
    expect(files[0]).toMatch(/refactor-plan\.md$/);
  });
});
