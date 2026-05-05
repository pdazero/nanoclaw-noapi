import { updateContainerConfig } from '../../src/container-config.js';

/**
 * If NANOCLAW_DEFAULT_PROVIDER is set in the environment, write it to the
 * group's container.json `provider` field. No-op otherwise — leaves the
 * field unset so the runner falls back to its code default ("claude" SDK).
 *
 * Called from init-cli-agent.ts and init-first-agent.ts after each fresh
 * group is bootstrapped via initGroupFilesystem().
 */
export function applyDefaultProvider(folder: string): void {
  const provider = process.env.NANOCLAW_DEFAULT_PROVIDER;
  if (!provider) return;
  updateContainerConfig(folder, (c) => {
    c.provider = provider;
  });
}
