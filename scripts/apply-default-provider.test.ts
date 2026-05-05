import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/container-config.js', () => {
  const updateContainerConfig = vi.fn();
  return { updateContainerConfig };
});

import { applyDefaultProvider } from './lib/apply-default-provider.js';
import * as containerConfig from '../src/container-config.js';

describe('applyDefaultProvider', () => {
  beforeEach(() => {
    vi.mocked(containerConfig.updateContainerConfig).mockReset();
  });

  afterEach(() => {
    delete process.env.NANOCLAW_DEFAULT_PROVIDER;
  });

  it('writes the provider field when NANOCLAW_DEFAULT_PROVIDER is set', () => {
    process.env.NANOCLAW_DEFAULT_PROVIDER = 'claude-cli';
    applyDefaultProvider('some-group');

    const updateContainerConfig = vi.mocked(containerConfig.updateContainerConfig);
    expect(updateContainerConfig).toHaveBeenCalledTimes(1);
    expect(updateContainerConfig.mock.calls[0][0]).toBe('some-group');

    // Apply the mutator on a stub config and verify the field is set.
    const mutator = updateContainerConfig.mock.calls[0][1] as (c: { provider?: string }) => void;
    const stub: { provider?: string } = {};
    mutator(stub);
    expect(stub.provider).toBe('claude-cli');
  });

  it('is a no-op when NANOCLAW_DEFAULT_PROVIDER is unset', () => {
    applyDefaultProvider('some-group');
    const updateContainerConfig = vi.mocked(containerConfig.updateContainerConfig);
    expect(updateContainerConfig).not.toHaveBeenCalled();
  });

  it('is a no-op when NANOCLAW_DEFAULT_PROVIDER is empty string', () => {
    process.env.NANOCLAW_DEFAULT_PROVIDER = '';
    applyDefaultProvider('some-group');
    const updateContainerConfig = vi.mocked(containerConfig.updateContainerConfig);
    expect(updateContainerConfig).not.toHaveBeenCalled();
  });
});
