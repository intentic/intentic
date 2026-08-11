# @intentic/acp-bridge

Drive the agents in your [intentic](https://intentic.dev) sandbox from your own editor.

Claude, Codex, Grok or any installed ACP agent, reached from Zed, JetBrains, or anything else speaking the
[Agent Client Protocol](https://agentclientprotocol.com). The bridge is a thin stdio adapter the editor
spawns locally; the agent itself runs remotely in your sandbox, and your
[synced folder](https://intentic.dev/docs/your-machine/#desktop-sync) mirrors its edits back so diffs and jump-to-file
line up in the editor.

## Setup

1. In the intentic app: **Sandbox → Sync → Editor bridge (ACP) → Mint token**. Copy the token (shown once)
   or the generated snippet.
2. Zed `settings.json` (JetBrains takes the same command + env):

```json
{
    "agent_servers": {
        "intentic": {
            "type": "custom",
            "command": "npx",
            "args": ["@intentic/acp-bridge"],
            "env": {
                "INTENTIC_SANDBOX_URL": "https://sandbox-….intentic.dev",
                "INTENTIC_CONTROL_TOKEN": "ict_…"
            }
        }
    }
}
```

Alternatively run `npx @intentic/acp-bridge login` once — credentials persist in `~/.intentic/acp/`.

3. Open your synced sandbox folder as the editor project, pick the **intentic** agent in the agent panel,
   and chat. Switch the agent with `INTENTIC_AGENT` (`claude` default, `codex`, `grok`, or an installed ACP
   capability id); pin a model with `INTENTIC_MODEL`.

## What maps how

- Tool calls stream with kinds, statuses, file locations, and inline diffs (paths joined onto your project
  root — open the synced folder for exact alignment).
- The **Plan** mode proposes first: approval rides the editor's permission prompt ("Approve plan" / "Keep
  planning"). Clarifying questions arrive the same way, one prompt per question.
- The sandbox does all file/terminal I/O remotely; the bridge deliberately declines the editor's fs and
  terminal capabilities (your synced folder is the local mirror).
- Cancel stops the stream (soft — the sandbox turn may finish server-side). Revoking the token in the app
  cuts the bridge off immediately.

## Key files

- [src/bridge.ts](src/bridge.ts) — the adapter itself: editor on stdio, sandbox over the wire.
- [src/translate.ts](src/translate.ts) — ACP messages to and from the daemon's own shapes.
- [src/daemon-client.ts](src/daemon-client.ts) — the remote half of the connection.
- [src/login.ts](src/login.ts) / [src/config.ts](src/config.ts) — pairing an editor with a sandbox, and remembering it.
- [src/cli.ts](src/cli.ts) — what the editor actually spawns.
