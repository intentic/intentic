# @intentic/host

The agent that runs on a **user's own computer** so their sandbox can work there — the machine half of the
`host` capability (the sandbox half is `_apps/sandbox/src/hosts/`).

```
your laptop                                    your sandbox
┌────────────────────────────┐                 ┌─────────────────────────────┐
│ intentic-host              │  one outbound   │ /system/hosts/connect  (hub)│
│  ├─ oRPC server            │ ───── wss ────▶ │   holds the oRPC CLIENT     │
│  │   describe/setScopes/   │  hostContract   │ /mcp/hosts/<id>  (bridge)   │
│  │   ping/mcp              │                 │        ▲                    │
│  ├─ MCP tools              │                 │   the agent's tools         │
│  ├─ policy (the grant)     │                 └─────────────────────────────┘
│  └─ audit log              │
└────────────────────────────┘
```

## Why it is shaped like this

**The machine dials out.** A laptop sits behind NAT, a corporate proxy and a closed lid — nothing can dial it.
So it holds one ordinary outbound WebSocket and everything multiplexes over that: no open ports, no router
configuration, no VPN.

**The machine is the server, though it placed the call.** After one plain-JSON `hello` carrying the enrollment
token, the socket becomes oRPC: this package serves `hostContract`
(`_libs/sandbox-contract/src/contracts/host.contract.ts`) and the daemon holds the client. oRPC's websocket
adapter attaches to either peer, so who dialled and who serves are independent — and request/response
correlation, argument validation and error shape all belong to the link rather than to hand-rolled framing.

**The tools live here, not in the sandbox.** `hostContract` has exactly one deliberately untyped procedure —
`mcp` — carrying MCP JSON-RPC verbatim in both directions. That hole is the point: if the contract described
each tool, the daemon would have to know every schema and translate, and this computer could no longer learn a
tool without a matching daemon release. What the machine can do is decided by `src/mcp.ts`, here.

**The grant is enforced here.** `src/policy.ts` is the only place a scope is checked. The sandbox pushes the
owner's switches down on every connect and whenever they are edited; this agent refuses everything outside them
and says which switch to flip. That placement is the security argument for the whole feature: the sandbox asks,
the machine answers.

## The surface

| Tool | Notes |
| --- | --- |
| `describe` | OS, shell, home, allowed folders. The agent's first call — it is the difference between writing for this machine and guessing. |
| `run_command` | PowerShell on Windows, the login shell elsewhere. Every command has a deadline; stdin is closed so nothing can hang waiting for input. |
| `read_file` / `list_dir` | Bounded by the allowed folders. |
| `write_file` / `trash_file` | Also need the write switch, which is **off** unless the user turned it on. There is no delete tool — `trash_file` moves the file somewhere recoverable. |
| `screenshot` | Windows via .NET; Linux via grim/spectacle/import/scrot, picked by session type. |

## Commands

```sh
intentic-host setup --url https://sandbox-… --pair <token>   # what the card's one-liner runs
intentic-host status                                          # what it is connected to, and what it may do
intentic-host run --foreground                                # the connection loop, watchable
intentic-host uninstall                                       # disconnect and forget the credential
```

State lives in `~/.intentic/host`: `config.json` (0600 — sandbox URL, machine id, enrollment token, cached
scopes), `audit.jsonl` (every call, kept even across an uninstall — it is the user's record, not the agent's),
`host.log`, and `trash/`.

## Gotchas worth knowing before editing

- **Windows spawns need `windowsHide`, not `detached`.** `DETACHED_PROCESS` leaves the process without a
  console, and Windows then gives every console grandchild one of its own — a black window per command.
- **The enrollment token rides the hello FRAME, never the URL.** A durable credential in a query string ends up
  in edge logs, connector logs and every proxy between here and the sandbox.
- **A refusal is a value, not an exception.** Scope errors come back as ordinary tool results so the model tells
  the user which switch to flip instead of reporting a broken sandbox and retrying.
- **The binary is compiled with `bun build --compile`**, so `process.argv[1]` is a path *inside* the executable.
  `cliLauncher()` handles that; passing the entry explicitly to a compiled binary breaks the autostart entry.
- **The install and lifecycle plumbing is not in this package.** The `~/.intentic/host` home and its 0600 floor,
  self-relaunch, login autostart and the detached connection loop all come from
  [`@intentic/local-agent`](../../_libs/local-agent), shared with `@intentic/sync` and `@intentic/acp-bridge`.
  `src/autostart.ts` here is only this agent's spec — and it declares no macOS `launchAgent`, because the
  connection loop has never been run on a Mac. Opting in is three lines once someone has.
