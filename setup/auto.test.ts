import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { checkCommandExists, readEnvLine } from './auto.js';

describe('readEnvLine', () => {
  let tmp: string;
  let prevCwd: string;

  beforeEach(() => {
    prevCwd = process.cwd();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-readenv-'));
    process.chdir(tmp);
  });

  afterEach(() => {
    process.chdir(prevCwd);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('returns null when .env is missing', () => {
    expect(readEnvLine('FOO')).toBeNull();
  });

  it('returns null when the key is absent', () => {
    fs.writeFileSync(path.join(tmp, '.env'), 'OTHER=1\n');
    expect(readEnvLine('FOO')).toBeNull();
  });

  it('returns the value when the key is present', () => {
    fs.writeFileSync(path.join(tmp, '.env'), 'FOO=bar\nBAZ=qux\n');
    expect(readEnvLine('FOO')).toBe('bar');
  });

  it('returns the last occurrence when the key is duplicated', () => {
    fs.writeFileSync(path.join(tmp, '.env'), 'FOO=first\nFOO=second\n');
    expect(readEnvLine('FOO')).toBe('second');
  });

  it('trims trailing whitespace from the value', () => {
    fs.writeFileSync(path.join(tmp, '.env'), 'FOO=bar   \n');
    expect(readEnvLine('FOO')).toBe('bar');
  });
});

describe('checkCommandExists', () => {
  it('returns true for a binary that exists on PATH (node)', () => {
    expect(checkCommandExists('node')).toBe(true);
  });

  it('returns false for a binary that does not exist', () => {
    expect(checkCommandExists('nanoclaw-no-such-binary-xyz123')).toBe(false);
  });
});
