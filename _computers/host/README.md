# @intentic/host

The small program on your own computer that lets your sandbox work there.

It is the machine half of the `host` capability; the sandbox half is `_sandbox/sandbox/src/hosts/`.

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
(`_sandbox/sandbox-contract/src/contracts/host.contract.ts`) and the daemon holds the client. oRPC's websocket
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
| `list_sandboxes` / `manage_sandbox` | The Intentic sandboxes running on this machine: list them, start/stop/restart one (tunnel sidecar included). Managing takes its own switch, **off** by default — narrower than `run_command`, so the machine's fleet can be delegated to a sandbox without handing it a shell. Listing is subsumed by either switch. |
| `swap_sandbox` / `sandbox_logs` | Update one onto a newer image, roll it back, rebuild its approved overlay — and read its container log. The swap runs `ic`, takes minutes, and keeps /work and /history; it rides the same `sandboxes` switch, and logs ride the same rule as listing. |
| `remove_sandbox` | Delete one, with its files and its history. Its **own** switch, off by default: everything under `sandboxes` is undone by doing it again, and this is undone by nothing. |

## The sandbox flows are not reimplemented here

`swap_sandbox` and `remove_sandbox` spawn the [`ic`](../../_sandbox/ic) CLI that the setup one-liner already put
on this machine — the same binary the pasted command, the desktop app's buttons and a hand-typed `ic` run. This
package is the fourth caller of one implementation, not a second copy of it, which is the argument the desktop
app makes for spawning the scripts instead of porting them into Rust.

`ic` is looked for where the installers put it (`~/.intentic/ic/bin`, then `/usr/local/bin`) before PATH, and
the path is built for the TARGET platform rather than by `node:path` — this agent's Windows spelling is asserted
from a Linux runner, so a function that answers in the running host's dialect could not be checked.

## Watching a flow, rather than being told about it afterwards

An update pulls an image and recreates a container: minutes in which an MCP tool result can say nothing at all.
So `hostContract` carries one **typed, streaming** procedure beside the opaque `mcp` one — `runSandboxFlow` —
which the browser's Computers view reads live. Both doors call the same functions in `src/tools/sandboxes.ts`,
so what a person watches and what the agent is told can never describe one run differently.

Typed, unlike `mcp`, because the reader is different: a model gains nothing from a line as it arrives and
everything from this machine learning tools without a daemon release, while a person watching a progress log
needs exactly the opposite.

## Commands

Most machines never run that one-liner by hand any more: `ic sandbox connect` installs this agent as part of
setting a sandbox up, redeeming a pairing the platform minted with the setup code. A computer connected that way
arrives with **`sandboxes` on and every other switch off** — no shell, no files, no screen — because installing a
sandbox is consent to running a sandbox, not to handing the agent inside it a laptop. Widening it is a click on
the card. See `_sandbox/sandbox/src/hosts/host-seed.ts`.

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

- **Every spawn in this package passes `windowsHide`.** The connection loop runs `detached` (without it, Windows
  tears it down with the command that started it), which leaves it with no console — and Windows gives a console
  child of a console-less process one of its own, window included. The flag is per-spawn for that reason: it
  applies whether or not the parent has a console.
- **The enrollment token rides the hello FRAME, never the URL.** A durable credential in a query string ends up
  in edge logs, connector logs and every proxy between here and the sandbox.
- **A refusal is a value, not an exception.** Scope errors come back as ordinary tool results so the model tells
  the user which switch to flip instead of reporting a broken sandbox and retrying.
- **The binary is compiled with `bun build --compile`**, so `process.argv[1]` is a path *inside* the executable.
  `cliLauncher()` handles that; passing the entry explicitly to a compiled binary breaks the autostart entry.
- **The install and lifecycle plumbing is not in this package.** The `~/.intentic/host` home and its 0600 floor,
  self-relaunch, login autostart and the detached connection loop all come from
  [`@intentic/local-agent`](../../_computers/local-agent), shared with `@intentic/sync` and `@intentic/acp-bridge`.
  `src/autostart.ts` here is only this agent's spec — and it declares no macOS `launchAgent`, because the
  connection loop has never been run on a Mac. Opting in is three lines once someone has.

## Key files

- [src/app.ts](src/app.ts) — the machine agent's own server and its lifecycle.
- [src/policy.ts](src/policy.ts) — what the sandbox is permitted to do on this machine; the security surface.
- [src/tools](src/tools) — the capabilities exposed: commands, files, screen.
- [src/connection.ts](src/connection.ts) — staying attached to the sandbox.
- [src/audit.ts](src/audit.ts) — what was done on this machine, recorded.
- [src/autostart.ts](src/autostart.ts) — installing as a background agent, per platform.
