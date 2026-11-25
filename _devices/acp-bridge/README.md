# acp-bridge

A stdio bridge that lets Zed, JetBrains or any Agent Client Protocol editor drive the agents in an intentic sandbox.

```mermaid
flowchart LR
    editor["Editor<br/>Zed · JetBrains"] -->|"ACP on stdio"| bridge(["intentic-acp"])
    bridge -->|"POST /agent<br/>/agent/attach"| daemon["Sandbox daemon"]
    daemon --> agents["Claude · Codex · Grok<br/>ACP agents"]
    bridge --> home["~/.intentic/acp<br/>config · sessions"]
```

- Runs on the user's machine: the editor launches `npx @intentic/acp-bridge` (bin `intentic-acp`) and talks ACP over
  stdin and stdout, so nothing else may write to stdout.
- One ACP session is one daemon conversation. `POST /agent` starts a turn, `/agent/attach` streams it back, and
  `translate.ts` turns each frame into a `session/update`, rewriting `/work` paths onto the editor's cwd. Open the
  synced folder as the project so those paths line up.
- A plan card, each `AskUserQuestion` and a permission card (the command judge, a host guard, an owner's rule) become
  ACP permission requests; allow-always is offered only where the card names what it would remember, and a reject or a
  cancel answers deny. Every other card (a browser or terminal hand-over, a connection, a payment) has no ACP control,
  so the editor gets one line saying to answer it in the sandbox app. The `code` and `plan` modes map to the daemon's
  per-turn permission mode.
- Credentials come from `INTENTIC_SANDBOX_URL` and `INTENTIC_CONTROL_TOKEN`, or from `intentic-acp login`. The token
  is an editor-scoped control token minted in the sandbox app; a 401 reaches the editor as ACP `auth_required`.
- [agent-registry/agent.json](agent-registry/agent.json) is the listing for ACP agent registries.
- SDK 2 uses the `/unstable` entrypoint throughout the bridge and its in-process test peer, preserving the extended
  authentication methods and usage updates the integration already sends. The wire protocol remains ACP v1.

## Key files

- [src/cli.ts](src/cli.ts) — entry point: `login`, or serve ACP on stdio.
- [src/bridge.ts](src/bridge.ts) — `bridgeAgentApp`: sessions, modes, and plans, questions and permission cards as permission requests.
- [src/translate.ts](src/translate.ts) — attach frames to `session/update`, sandbox paths to editor paths.
- [src/daemon-client.ts](src/daemon-client.ts) — the daemon routes the bridge calls, with the control-token header: paths from the contract's procedures, answers read with its schemas.
- [src/config.ts](src/config.ts) — environment-then-file config and the ACP session to conversation map.
- [src/bridge.integration.test.ts](src/bridge.integration.test.ts) — the whole bridge against a fake daemon.

## Commands

```sh
pnpm --filter @intentic/acp-bridge test
```
