/**
 * Host-side container config for the `claude-cli` agent provider.
 *
 * Responsibilities per spawn:
 *   1. Verify the host has run `claude /login` (master credentials exist).
 *   2. Lazily copy/refresh the OAuth credentials into a per-session control
 *      dir (sibling of `<sessionDir>`, NOT under it — would otherwise be
 *      reachable via the `/workspace` RW mount, defeating the RO nesting).
 *   3. Regenerate the settings.json + mcp.json control files from the
 *      static template + container.json mcpServers. Regenerated every spawn
 *      so any in-container tampering during the previous lifetime is
 *      discarded — defense in depth on top of the nested RO mount.
 *   4. Return the three nested-RO mounts that overlay the per-group
 *      `.claude-shared` RW base at `/home/node/.claude/`.
 *
 * The base RW mount itself is not contributed here: the container-runner
 * already adds `<DATA_DIR>/v2-sessions/<group>/.claude-shared` →
 * `/home/node/.claude:rw` for every spawn.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { registerProviderContainerConfig, type VolumeMount } from './provider-container-registry.js';

/**
 * Hooks JSON template. Bun executes .ts directly inside the container — there
 * is no tsc build step (see CLAUDE.md), so we point at the .ts source paths
 * under the read-only `/app/src` mount.
 */
const SETTINGS_TEMPLATE = {
  hooks: {
    PreToolUse: [{ command: 'bun /app/src/providers/claude-cli-hooks/pre-tool-use.ts' }],
    PostToolUse: [{ command: 'bun /app/src/providers/claude-cli-hooks/post-tool-use.ts' }],
    PostToolUseFailure: [{ command: 'bun /app/src/providers/claude-cli-hooks/post-tool-use.ts' }],
    PreCompact: [{ command: 'bun /app/src/providers/claude-cli-hooks/pre-compact.ts' }],
  },
};

/**
 * Built-in nanoclaw MCP server entry, hard-coded to the in-container path
 * of the agent-runner mount (`/app/src/`). Matches what the agent-runner's
 * `index.ts` would generate for its in-process SDK provider.
 */
const NANOCLAW_BUILTIN_MCP = {
  command: 'bun',
  args: ['run', '/app/src/mcp-tools/index.ts'],
  env: {},
};

function controlDir(sessionDir: string, agentGroupId: string): string {
  // Walk one level up from <sessionDir> = <DATA>/v2-sessions/<group>/<session>
  // to <DATA>/v2-sessions/<group>, then add the sibling .claude-cli-control/<session>.
  const groupDir = path.dirname(sessionDir);
  const sessionId = path.basename(sessionDir);
  if (path.basename(groupDir) !== agentGroupId) {
    // Safety net: if the layout ever changes, fail loudly rather than write
    // creds to the wrong path. The runner builds <sessionDir> from
    // sessionDir(agentGroup.id, session.id) — basename(dirname(sessionDir))
    // must equal agentGroupId by construction.
    throw new Error(
      `claude-cli: unexpected sessionDir layout — expected basename(${groupDir}) === '${agentGroupId}'`,
    );
  }
  return path.join(groupDir, '.claude-cli-control', sessionId);
}

function copyCredentialsIfNewer(hostCreds: string, sessCreds: string): void {
  fs.mkdirSync(path.dirname(sessCreds), { recursive: true });
  if (!fs.existsSync(sessCreds) || fs.statSync(hostCreds).mtimeMs > fs.statSync(sessCreds).mtimeMs) {
    fs.copyFileSync(hostCreds, sessCreds);
    try {
      fs.chmodSync(sessCreds, 0o600);
    } catch {
      /* best effort */
    }
  }
}

registerProviderContainerConfig('claude-cli', (ctx) => {
  const hostCreds = path.join(os.homedir(), '.claude', '.credentials.json');
  if (!fs.existsSync(hostCreds)) {
    throw new Error(
      "provider 'claude-cli' requires `claude /login` on the host first " +
        '(no ~/.claude/.credentials.json found). Run `claude /login` and retry.',
    );
  }

  const dir = controlDir(ctx.sessionDir, ctx.agentGroupId);
  fs.mkdirSync(dir, { recursive: true });

  copyCredentialsIfNewer(hostCreds, path.join(dir, '.credentials.json'));

  // Regenerate settings.json + mcp.json on every spawn (defense in depth).
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(SETTINGS_TEMPLATE, null, 2));
  fs.writeFileSync(
    path.join(dir, 'mcp.json'),
    JSON.stringify(
      { mcpServers: { nanoclaw: NANOCLAW_BUILTIN_MCP, ...ctx.containerConfig.mcpServers } },
      null,
      2,
    ),
  );

  const mounts: VolumeMount[] = [
    {
      hostPath: path.join(dir, '.credentials.json'),
      containerPath: '/home/node/.claude/.credentials.json',
      readonly: true,
    },
    {
      hostPath: path.join(dir, 'settings.json'),
      containerPath: '/home/node/.claude/settings.json',
      readonly: true,
    },
    {
      hostPath: path.join(dir, 'mcp.json'),
      containerPath: '/home/node/.claude/mcp.json',
      readonly: true,
    },
  ];

  return { mounts };
});
