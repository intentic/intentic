# @intentic/machine

The one agent that lives on a user's own computer: it lets a sandbox's agent work on the machine, and keeps the
machine's folders and ports mirrored with the sandbox — one binary, one resident loop, one logon entry.

It replaces two agents (`@intentic/host` and `@intentic/sync`) that shared everything about *being installed* —
a resident loop, a pidfile, a login entry, an updater, a ~90 MB compiled binary — and nothing about what they
did. Merging them halves what a machine downloads and keeps resident, and gives "is this machine's agent
running" one answer instead of two halves of one.

## Responsibilities

The **computer half** (`src/computer/`, the machine side of the `host` capability):

- Dial each linked sandbox — one outbound WebSocket, enrollment token in the first frame, oRPC after that; the
  machine *serves* `hostContract`, so no port ever opens here.
- Expose the tool surface (`run_command`, files, screenshot, `describe`; deliberately no delete — trash is
  recoverable) as MCP carried verbatim, so a machine can learn a tool without a daemon release.
- Enforce the owner's scopes **here**, never in the sandbox, and append every call to an audit log that
  survives uninstall.
- Keep each local sandbox's **next update downloaded** (`src/computer/auto-prepare.ts`): a background tick
  runs `ic sandbox prepare <slug> --auto` every few hours, so the web app's update card offers a half-minute
  restart instead of minutes of pulling. On by default; the switch is `intentic-machine computer updates
  --off` (cached in `computer.json`). Nothing in any sandbox can start or steer the tick — a sandbox only
  learns the outcome through the staged marker `ic` writes, the way it always has.

The **sync half** (`src/sync/`, the machine side of desktop sync):

- Enroll an SSH key, then drive Mutagen: bidirectional file sync of a local folder ↔ the sandbox's /work, plus
  a one-way backup of the sandbox's own state.
- Serve the SSH transport itself on loopback (the sandbox's sshd reached over its HTTPS surface), mirror every
  workspace port onto this machine's localhost, and bridge git so commits appear in local clones.
- **Dial a sandbox that runs on this very machine directly** ([src/sync/daemon-base.ts](src/sync/daemon-base.ts)):
  the container publishes its daemon on `127.0.0.1:<port derived from the sandbox id>`, so the transport, the
  ports poll and the machine report use that instead of sending a multi-gigabyte Mutagen sync out to the
  reachability edge and back to the same laptop. A candidate is adopted only if the daemon's unauthenticated
  `/health` answers with the id we expected — a port is not a sandbox, and the sync token is what would be
  presented to whoever holds it. The sandbox's public URL stays the floor under every pairing, and a pairing
  sitting on it is re-probed each minute, so a container started after the watcher gets promoted with no restart.
- Own the **port-mirroring switch** (`sync mirror off|on`, optionally `--sandbox <id>`): mirroring is the one
  thing here that writes to *this* computer's localhost, so the flag lives on this side, survives a restart, and
  is read every tick. File sync, the state backup and the git bridge are untouched by it — the point is to stop
  the ports without unpairing the sandbox. The sandbox's Computers tab has a button for it, and that button runs
  this very command over the `host` capability, so the two can never disagree. The same is true of the other
  three per-pairing verbs — `sync pause`, `sync resume` and `sync uninstall --sandbox <id>` — each of which is a
  button on the row that describes what it changes: pause and unpair under the folder, mirroring under the ports.
  Every one of them is scoped by `--sandbox` from the row, because bare they act on every sandbox this machine
  pairs, which is a reasonable thing to mean in a terminal and never what a button on one row should do to a
  colleague's pairing on the same computer.
- Register Mutagen's daemon for login autostart — on Windows through the launcher stub, because Mutagen's own
  registration flashes a console window at every boot.

**Shared** (`src/`): the one resident loop (`run`), the merged `status` (and its `--json` envelope the desktop
app's tray reads), self-`upgrade` with automatic rollback, and the autostart spec.

## The resident loop

`intentic-machine run --foreground` (what systemd, launchd and the Windows launcher stub run) serves both
halves in one process ([src/resident.ts](src/resident.ts)):

- The sync half re-reads its pairing list every tick; the computer half's link list is fixed at startup, which
  is why every `setup`/`uninstall` restarts the loop (`reconcileResidency`) instead of poking it.
- The process exits — and takes the login entry with it — only when **both** halves have nothing to serve.
- On a signal it exits `128+signal`, never 0: a supervisor must restart what it did not stop, and the incident
  that bought that rule is written out in [src/sync/mirror.ts](src/sync/mirror.ts).

## Key files

- [src/commands.ts](src/commands.ts) — the CLI surface: `computer setup|uninstall|updates`, `sync setup|pause|resume|mirror|uninstall`, shared `run|status|version|upgrade|uninstall`.
- [src/install.ts](src/install.ts) — what every `setup` runs first: self-update (then re-exec), PATH repair, the Windows launcher stub. Everything the install scripts used to decide, decided once here.
- [src/upgrade.ts](src/upgrade.ts) — `upgrade`: what is published, then download → probe → stop → swap → start, with a rollback behind every step.
- [src/resident.ts](src/resident.ts) — the one loop, its pidfile, and `reconcileResidency`.
- [src/computer/auto-prepare.ts](src/computer/auto-prepare.ts) — the background update-download tick; the judgement about *what* to download stays in `ic sandbox prepare --auto`, on purpose.
- [src/status.ts](src/status.ts) — both halves as one answer; `--json` is what the desktop app and tray read.
- [src/computer/policy.ts](src/computer/policy.ts) — what the sandbox is permitted to do here; the security surface.
- [src/sync/mirror.ts](src/sync/mirror.ts) — the sync tick: ports reconcile, git bridge, revocation handling.
- [src/sync/mutagen.ts](src/sync/mutagen.ts) — driving the Mutagen binary, sessions and its daemon's autostart.

## How it fits

Runs on the user's machine, not in the sandbox. Installed by `computer.{sh,ps1}` / `sync.{sh,ps1}` (both cards
put the same binary in `~/.intentic/machine/bin`), shipped as a bun-compiled binary per platform, self-updated
by `upgrade`.

Those four installers are **bootstrap shims**: they download a first agent onto a machine that has none
(pinned to the tag `releases/latest` resolves to, resumable, probed by running `version` before it may become
the agent) and exec `setup`. Every other decision — installed-vs-published, PATH repair, the Windows launcher
stub — runs from [src/install.ts](src/install.ts) at the top of every `setup`: it self-updates through the
same download→probe→swap→rollback machinery as `upgrade`, then re-execs the new agent with the same argv, so
re-running a card's command still upgrades a machine while the rule lives in exactly one compiled, tested
place. The shims' remaining bootstrap blocks are held identical per dialect by
[src/installers.test.ts](src/installers.test.ts), which also pins that no decision creeps back into shell.

The install-and-stay-alive plumbing is
[`@intentic/local-agent`](../local-agent)'s; the windowless Windows logon start is
[`_computers/win-launcher`](../win-launcher)'s.

## Conventions & gotchas

- **Bidirectional sync has no undo.** The integration tests here run against real directories and a real
  Mutagen for exactly that reason; a unit test that mocks the sync proves nothing about the case that loses work.
- **The two halves keep separate state files** (`computer.json`, `sync.json`) in the one home: the loop rewrites
  one half's state while a concurrent `setup` writes the other's, and separate files make cross-half torn
  writes impossible rather than unlikely.
- **Scopes are a cache.** The sandbox pushes the real grant on every connect; what is stored only governs the
  seconds before the first push, and it starts at everything-off.
- **The transport lives in the resident loop**, so `sync setup` starts the loop *before* it probes ssh or hands
  anything to Mutagen: every step after that one needs the port to be open.
