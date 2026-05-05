# Claude CLI provider (built-in)

The `claude-cli` provider invokes the Claude Code CLI (`/pnpm/claude`) in
headless mode (`claude -p`) instead of using the SDK. Auth is the host's
OAuth login — no `ANTHROPIC_API_KEY`, no OneCLI proxy for AI traffic.

It coexists with the default `claude` (SDK) provider; the choice is
per-agent-group via `container.json`.

## Activate via setup wizard

When you run `bash nanoclaw.sh`, the auth menu offers four options. Choose
**"Use my host Claude Code CLI session"** to make `claude-cli` the default
provider for every new agent group on this install. The wizard verifies
that `claude` is on PATH and that `~/.claude/.credentials.json` exists; if
either is missing, it fails with a clear message and you fix it on the host
(`https://claude.ai/install.sh` to install, then `claude /login`) and re-run.

The wizard sets `NANOCLAW_DEFAULT_PROVIDER=claude-cli` in `.env`.
`scripts/init-cli-agent.ts` and `scripts/init-first-agent.ts` read that
variable and write `"provider": "claude-cli"` into each new group's
`container.json`. Existing groups are not modified.

To switch a single group back to the SDK provider, edit
`groups/<folder>/container.json` and remove the `provider` field (or set it
to `"claude"`).

## Prerequisites

Run `claude /login` on the host once. NanoClaw uses the resulting
`~/.claude/.credentials.json` file as the source of truth and copies it
per-session into a control dir, refreshing it on `mtime` changes.

## Activate for a group

Edit `groups/<folder>/container.json`:

```json
{ "provider": "claude-cli" }
```

Restart the agent's container. New spawns will use the CLI provider.

## How it differs from `claude` (SDK)

| Behavior                       | SDK provider | CLI provider |
|--------------------------------|--------------|--------------|
| Auth                           | OneCLI proxy / API key | Host OAuth login |
| Hooks                          | In-process callbacks | On-disk scripts (`bun /app/src/providers/claude-cli-hooks/*.ts`) |
| Push mid-stream                | Yes (`MessageStream`) | No — single-turn per spawn (next message arrives at next wakeup with `--resume`) |
| Native slash commands          | Yes | Yes |

## How it works

Per-spawn the host writes a control dir at:
```
<DATA_DIR>/v2-sessions/<group_id>/.claude-cli-control/<session_id>/
  ├── .credentials.json    ← copied from ~/.claude/.credentials.json (mtime-gated)
  ├── settings.json        ← static template wiring up hook scripts
  └── mcp.json             ← container.json mcpServers + built-in nanoclaw entry
```

This dir is NOT under `<sessionDir>` — the agent's `/workspace` mount cannot
reach it, so the agent cannot tamper with the control files via writable
container paths.

Three nested-RO mounts overlay the per-group `.claude-shared` RW base:
```
<control>/.credentials.json → /home/node/.claude/.credentials.json:ro
<control>/settings.json     → /home/node/.claude/settings.json:ro
<control>/mcp.json          → /home/node/.claude/mcp.json:ro
```

The CLI is invoked with `--mcp-config /home/node/.claude/mcp.json --settings /home/node/.claude/settings.json`,
plus `--resume <session_id>` when the previous turn returned a continuation.

## Hooks

| Hook              | Script                                        | Purpose |
|-------------------|-----------------------------------------------|---------|
| `PreToolUse`      | `pre-tool-use.ts`                             | Block denylist tools; record container_state for stuck-tolerance widening |
| `PostToolUse`     | `post-tool-use.ts`                            | Clear container_state |
| `PostToolUseFailure` | `post-tool-use.ts`                         | Same — clear on failure too |
| `PreCompact`      | `pre-compact.ts`                              | Archive transcript to `/workspace/agent/conversations/` |

## Troubleshooting

- **`provider 'claude-cli' requires claude /login on the host first`** — Run `claude /login` and retry. The host master credentials file is missing.
- **Refresh token expired** — The CLI inside the container will fail at startup. Run `claude /login` again on the host; the next sweep tick (≤ 60s) will resync into running sessions.
- **Hooks don't fire** — Check that `/home/node/.claude/settings.json` exists inside the container (`docker exec <name> cat /home/node/.claude/settings.json`). If the file is empty/wrong, the host's per-spawn regeneration step has been bypassed somehow — re-spawn the container.

## Limitations

- No mid-stream push: messages arriving while the CLI is mid-turn are processed at the next wakeup, not appended to the current turn. The semantic difference is small in practice — the next-turn hand-off carries `--resume <session_id>` so context is preserved.
- The CLI binary is pinned via `CLAUDE_CODE_VERSION` in `container/build.sh`. If the CLI's `--output-format stream-json` shape changes between versions, update `translateStreamJsonLines` and its tests.

## Out of scope

- A `/use-claude-cli-provider` skill to flip the provider without editing JSON.
- Migrating existing groups from `claude` (SDK) to `claude-cli` automatically.
- `--input-format stream-json` for mid-stream push.
