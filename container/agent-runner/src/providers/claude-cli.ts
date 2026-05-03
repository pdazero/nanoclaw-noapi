/**
 * Claude CLI provider — invokes /pnpm/claude in headless mode with
 * stream-json output, instead of going through the SDK. Auth uses the
 * host's OAuth login (no ANTHROPIC_API_KEY, no OneCLI proxy for the AI
 * traffic). Hook scripts on disk enforce the same denylist + container_state
 * tracking the SDK provider does in-process.
 *
 * The class itself arrives in a later task; this file currently exports the
 * pure argv builder so it can be unit-tested in isolation.
 */
import { DISALLOWED_TOOLS, TOOL_ALLOWLIST } from './tool-policies.js';

const DEFAULT_MCP_CONFIG_PATH = '/home/node/.claude/mcp.json';
const DEFAULT_SETTINGS_PATH = '/home/node/.claude/settings.json';

export interface BuildClaudeCliArgsInput {
  prompt: string;
  cwd: string;
  continuation?: string;
  systemContext?: { instructions?: string };
  additionalDirectories?: string[];
  /** Override the default `/home/node/.claude/mcp.json` (used in tests). */
  mcpConfigPath?: string;
  /** Override the default `/home/node/.claude/settings.json` (used in tests). */
  settingsPath?: string;
}

/**
 * Build the argv for `Bun.spawn(['/pnpm/claude', ...buildClaudeCliArgs(...)])`.
 *
 * Pure function — no env, no fs, no spawning. The caller spawns.
 *
 * Security note (`--` separator): the formatter (`formatter.ts`) currently
 * guarantees prompts start with `<context ...>` or `/`, but that's an
 * emergent property of the formatter and could regress. We append `--`
 * before the prompt so the CLI argv parser stops looking for flags first;
 * any leading `--` in the prompt is treated as positional. Cost zero,
 * locality of safety high.
 */
export function buildClaudeCliArgs(input: BuildClaudeCliArgsInput): string[] {
  const args: string[] = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--allowedTools',
    TOOL_ALLOWLIST.join(','),
    '--disallowedTools',
    DISALLOWED_TOOLS.join(','),
    '--permission-mode',
    'bypassPermissions',
    '--dangerously-skip-permissions',
    '--mcp-config',
    input.mcpConfigPath ?? DEFAULT_MCP_CONFIG_PATH,
    '--settings',
    input.settingsPath ?? DEFAULT_SETTINGS_PATH,
  ];

  if (input.continuation) {
    args.push('--resume', input.continuation);
  }

  if (input.systemContext?.instructions) {
    args.push('--append-system-prompt', input.systemContext.instructions);
  }

  if (input.additionalDirectories) {
    for (const dir of input.additionalDirectories) {
      args.push('--add-dir', dir);
    }
  }

  // End-of-flags separator + positional prompt. See note above.
  args.push('--', input.prompt);

  return args;
}
