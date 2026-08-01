# @intentic/host

The agent that runs on a **user's own computer** so their sandbox can work there — the machine half of the
`host` capability (the sandbox half is `_apps/sandbox/src/hosts/`).

```
your laptop                                    your sandbox
┌────────────────────────────┐                 ┌─────────────────────────────┐
│ intentic-host              │  one outbound   │ /system/hosts/connect  (hub)│
│  ├─ MCP server (tools)     │ ───── wss ────▶ │ /mcp/hosts/<id>  (bridge)   │
│  ├─ policy (the grant)     │                 │        ▲                    │
│  └─ audit log              │                 │   the agent's tools         │
└────────────────────────────┘                 └─────────────────────────────┘
```

## Why it is shaped like this

**The machine dials out.** A laptop sits behind NAT, a corporate proxy and a closed lid — nothing can dial it.
So it holds one ordinary outbound WebSocket and everything multiplexes over that: no open ports, no router
configuration, no VPN.

**The tools live here, not in the sandbox.** The daemon forwards MCP JSON-RPC verbatim and interprets none of
it, so what this computer can do is decided by `src/mcp.ts` in this package. A machine that upgrades learns new
tools without a sandbox release — and a sandbox that is compromised learns nothing about how to do more.

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
