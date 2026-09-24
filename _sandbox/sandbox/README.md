# sandbox

The Node daemon at the center of every sandbox: it runs coding agents in git worktrees, serves the workspace to the editor, and lands and checks their work.

```mermaid
flowchart LR
    editor["Editor<br/>web · desktop · mobile"] --> edge["Platform ingress edge"]
    edge -->|"tunnel"| front["intentic-front<br/>ports · TLS · tunnel"]
    peers["Devices · browser extension<br/>runners"] --> front
    front -->|"Unix socket"| daemon(["sandbox daemon"])
    daemon --> runtimes["Agent runtimes<br/>Claude Code · Codex · ACP"]
    runtimes --> worktrees["Worktrees<br/>one per conversation"]
    worktrees -->|"land"| work["/work repos"]
    daemon --> ext["Extension backend host<br/>and gateways"]
    daemon --> history["/history<br/>state · logs · git dirs"]
```

- It runs as the child of `intentic-front` ([../front](../front)), which owns every port, the TLS certificate and
  the platform tunnel, and relays HTTP over a Unix socket. The daemon decides, the front binds.
- Two roots: `/work` is what agents edit; `/history` is the daemon's own (git dirs, worktrees, the conversation
  database, snapshots, logs) and sits outside `/work`.
- Routes are declared in `@intentic/sandbox-contract`, implemented in `*.routes.ts` and assembled in `src/router.ts`.
  `/events` pushes file, git and fleet changes to the browser.
- One turn: `agent/run/turn/turn-admission.ts` admits it, `turn-plan.ts` picks a runtime, it runs in the
  conversation's worktree (or the main tree, or a remote runner), `agents/land/land.ts` lands the result as
  uncommitted changes, and `verify-landed.ts` runs the repository's checks on it.
- Extension code never runs in the daemon process; it runs in a supervised backend host.

More: [subsystems](docs/subsystems.md) (how the parts connect), [environment](docs/env-contract.md) (what the daemon
reads at start), [debugging](docs/debugging.md) (logs, diagnostics, state on disk).

## Key files

- [src/main.ts](src/main.ts) — the entry point: boot phases in the one order that matters.
- [src/composition.ts](src/composition.ts) — `createServices` builds every subsystem once; `wireReactions` subscribes them to each other.
- [src/app.ts](src/app.ts) — the Hono app: security headers, boot gate, CORS, auth, raw routes, then the oRPC handler.
- [src/router.ts](src/router.ts) — the per-domain route factories assembled into the contract's shape.
- [src/env.config.ts](src/env.config.ts) — the configuration schema read from the environment.
- [src/agent/routes/agent.routes.ts](src/agent/routes/agent.routes.ts) — `streamAgent`: one turn, from placement to settlement.

## Layout

Main groups under `src/`:

| Concern | Directories |
| --- | --- |
| Turns and agents | `agent/` `agents/` `runtimes/` `sessions/` `personas/` `loops/` `workflows/` `guard/` `rules/` |
| Workspace | `workspace/` `git/` `history/` `derived/` `terminal/` `processes/` `ports/` `panels/` |
| Owner controls | `auth/` `secrets/` `areas/` `approvals/` `safety/` `usage/` `wallet/` `settings/` |
| Outside world | `capabilities/` `extensions/` `browser/` `hosts/` `peers/` `webext/` `runners/` `fleet/` `ci/` `automations/` |
| Network | `front/` `platform/` `tunnel/` `vpn/` `exit/` `netdisk/` `public/` `share/` `webchat/` |
| Plumbing | `bootstrap/` `store/` `seams/` `system/` `http/` `workers/` `logs/` `invariants/` |
| Test support | `harness/` `fences/` `e2e/` |

## Commands

```sh
pnpm --filter @intentic/sandbox test         # unit and integration suites
pnpm dev:sandbox                             # repo root: watch loop that rebuilds or restarts a dev sandbox
sh _sandbox/sandbox/scripts/dev-restart.sh   # recompile and restart the daemon inside a dev container
```
