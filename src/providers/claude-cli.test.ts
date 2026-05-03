import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Force registry import — must come before importing the module under test
// so the SUT's registerProviderContainerConfig() call lands.
import './claude-cli.js';
import { getProviderContainerConfig } from './provider-container-registry.js';

let tmpHome: string;
let tmpData: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-cli-host-home-'));
  tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-cli-host-data-'));
  vi.spyOn(os, 'homedir').mockReturnValue(tmpHome);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(tmpData, { recursive: true, force: true });
});

function makeContext(overrides: { mcpServers?: Record<string, unknown> } = {}) {
  const sessionDir = path.join(tmpData, 'v2-sessions', 'agent-1', 'sess-1');
  fs.mkdirSync(sessionDir, { recursive: true });
  return {
    sessionDir,
    agentGroupId: 'agent-1',
    hostEnv: {} as NodeJS.ProcessEnv,
    containerConfig: {
      mcpServers: (overrides.mcpServers as Record<string, never>) ?? {},
      packages: { apt: [], npm: [] },
      additionalMounts: [],
      skills: 'all' as const,
    },
  };
}

describe('host claude-cli provider config', () => {
  it('throws when host has no ~/.claude/.credentials.json', () => {
    const fn = getProviderContainerConfig('claude-cli');
    expect(fn).toBeDefined();
    expect(() => fn!(makeContext())).toThrow(/claude \/login/i);
  });

  it('copies ~/.claude/.credentials.json into the per-session control dir', () => {
    fs.mkdirSync(path.join(tmpHome, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(tmpHome, '.claude', '.credentials.json'), '{"oauth":"abc"}');

    const ctx = makeContext();
    const fn = getProviderContainerConfig('claude-cli')!;
    const out = fn(ctx);

    const controlDir = path.join(tmpData, 'v2-sessions', 'agent-1', '.claude-cli-control', 'sess-1');
    expect(fs.existsSync(path.join(controlDir, '.credentials.json'))).toBe(true);
    expect(fs.readFileSync(path.join(controlDir, '.credentials.json'), 'utf-8')).toBe('{"oauth":"abc"}');

    // Sibling-of-session-id placement: NOT under sessionDir.
    expect(controlDir.startsWith(ctx.sessionDir)).toBe(false);

    // Mount list contains the three nested-RO entries.
    const ros = (out.mounts ?? []).filter((m) => m.readonly);
    expect(ros.find((m) => m.containerPath === '/home/node/.claude/.credentials.json')).toBeDefined();
    expect(ros.find((m) => m.containerPath === '/home/node/.claude/settings.json')).toBeDefined();
    expect(ros.find((m) => m.containerPath === '/home/node/.claude/mcp.json')).toBeDefined();
    // No RW mount is added by this provider — base RW lives in the existing
    // .claude-shared mount the runner already adds.
    expect((out.mounts ?? []).filter((m) => !m.readonly).length).toBe(0);
  });

  it('regenerates settings.json + mcp.json on every spawn (defense-in-depth)', () => {
    fs.mkdirSync(path.join(tmpHome, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(tmpHome, '.claude', '.credentials.json'), '{"oauth":"a"}');

    const ctx = makeContext();
    const fn = getProviderContainerConfig('claude-cli')!;
    fn(ctx);

    const controlDir = path.join(tmpData, 'v2-sessions', 'agent-1', '.claude-cli-control', 'sess-1');

    // Corrupt files between spawns.
    fs.writeFileSync(path.join(controlDir, 'settings.json'), 'POISONED');
    fs.writeFileSync(path.join(controlDir, 'mcp.json'), 'POISONED');

    fn(ctx); // second spawn

    const settings = JSON.parse(fs.readFileSync(path.join(controlDir, 'settings.json'), 'utf-8'));
    expect(settings.hooks.PreToolUse).toBeDefined();
    expect(settings.hooks.PostToolUse).toBeDefined();
    expect(settings.hooks.PreCompact).toBeDefined();
    const mcp = JSON.parse(fs.readFileSync(path.join(controlDir, 'mcp.json'), 'utf-8'));
    expect(mcp.mcpServers.nanoclaw).toBeDefined();
  });

  it('mcp.json includes container.json mcpServers + the built-in nanoclaw entry', () => {
    fs.mkdirSync(path.join(tmpHome, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(tmpHome, '.claude', '.credentials.json'), '{"oauth":"a"}');
    const ctx = makeContext({
      mcpServers: { custom: { command: 'echo', args: ['hi'], env: {} } },
    });
    const fn = getProviderContainerConfig('claude-cli')!;
    fn(ctx);
    const controlDir = path.join(tmpData, 'v2-sessions', 'agent-1', '.claude-cli-control', 'sess-1');
    const mcp = JSON.parse(fs.readFileSync(path.join(controlDir, 'mcp.json'), 'utf-8'));
    expect(mcp.mcpServers.nanoclaw.command).toBe('bun');
    expect(mcp.mcpServers.nanoclaw.args).toContain('/app/src/mcp-tools/index.ts');
    expect(mcp.mcpServers.custom.command).toBe('echo');
  });

  it('only re-copies credentials when the host master is newer (mtime gate)', () => {
    fs.mkdirSync(path.join(tmpHome, '.claude'), { recursive: true });
    const hostCreds = path.join(tmpHome, '.claude', '.credentials.json');
    fs.writeFileSync(hostCreds, 'first');
    const oldTime = new Date('2020-01-01');
    fs.utimesSync(hostCreds, oldTime, oldTime);

    const ctx = makeContext();
    const fn = getProviderContainerConfig('claude-cli')!;
    fn(ctx);

    const controlDir = path.join(tmpData, 'v2-sessions', 'agent-1', '.claude-cli-control', 'sess-1');
    const sessCreds = path.join(controlDir, '.credentials.json');
    fs.writeFileSync(sessCreds, 'second');
    const newer = new Date('2025-01-01');
    fs.utimesSync(sessCreds, newer, newer);

    fn(ctx); // host is older, should NOT overwrite session copy
    expect(fs.readFileSync(sessCreds, 'utf-8')).toBe('second');

    // Now make host newer.
    const evenNewer = new Date('2026-01-01');
    fs.utimesSync(hostCreds, evenNewer, evenNewer);
    fs.writeFileSync(hostCreds, 'third');
    fs.utimesSync(hostCreds, evenNewer, evenNewer);

    fn(ctx);
    expect(fs.readFileSync(sessCreds, 'utf-8')).toBe('third');
  });
});
