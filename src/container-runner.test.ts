import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveProviderName } from './container-runner.js';
import './providers/index.js';
import { getProviderContainerConfig } from './providers/provider-container-registry.js';

describe('resolveProviderName', () => {
  it('prefers session over group and container.json', () => {
    expect(resolveProviderName('codex', 'opencode', 'claude')).toBe('codex');
  });

  it('falls back to group when session is null', () => {
    expect(resolveProviderName(null, 'codex', 'claude')).toBe('codex');
  });

  it('falls back to container.json when session and group are null', () => {
    expect(resolveProviderName(null, null, 'opencode')).toBe('opencode');
  });

  it('defaults to claude when nothing is set', () => {
    expect(resolveProviderName(null, null, undefined)).toBe('claude');
  });

  it('lowercases the resolved name', () => {
    expect(resolveProviderName('CODEX', null, null)).toBe('codex');
    expect(resolveProviderName(null, 'OpenCode', null)).toBe('opencode');
    expect(resolveProviderName(null, null, 'Claude')).toBe('claude');
  });

  it('treats empty string as unset (falls through)', () => {
    expect(resolveProviderName('', 'codex', null)).toBe('codex');
    expect(resolveProviderName(null, '', 'opencode')).toBe('opencode');
  });
});

describe('claude-cli provider host config (registry lookup)', () => {
  let tmpHome: string;
  let tmpData: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-cli-home-'));
    tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-cli-data-'));
    vi.spyOn(os, 'homedir').mockReturnValue(tmpHome);
    fs.mkdirSync(path.join(tmpHome, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(tmpHome, '.claude', '.credentials.json'), '{"oauth":"x"}');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(tmpData, { recursive: true, force: true });
  });

  it('is registered and returns three nested-RO mounts', () => {
    const sessionDir = path.join(tmpData, 'v2-sessions', 'g1', 's1');
    fs.mkdirSync(sessionDir, { recursive: true });

    const fn = getProviderContainerConfig('claude-cli');
    expect(fn).toBeDefined();

    const out = fn!({
      sessionDir,
      agentGroupId: 'g1',
      hostEnv: process.env,
      containerConfig: { mcpServers: {}, packages: { apt: [], npm: [] }, additionalMounts: [], skills: 'all' },
    });

    expect(out.mounts).toBeDefined();
    expect(out.mounts!.length).toBe(3);
    expect(out.mounts!.every((m) => m.readonly)).toBe(true);
    for (const m of out.mounts!) {
      expect(m.hostPath.startsWith(sessionDir + path.sep)).toBe(false);
    }
  });
});
