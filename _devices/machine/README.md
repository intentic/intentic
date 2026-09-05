# @intentic/machine

The one agent that lives on a user's own device: it lets a sandbox's agent work on the machine, and keeps the
machine's folders and ports mirrored with the sandbox — one binary, one resident loop, one logon entry.

It replaces two agents (`@intentic/host` and `@intentic/sync`) that shared everything about *being installed* —
a resident loop, a pidfile, a login entry, an updater, a ~90 MB compiled binary — and nothing about what they
did. Merging them halves what a machine downloads and keeps resident, and gives "is this machine's agent
running" one answer instead of two halves of one.

## Responsibilities

The **device half** (`src/device/`, the machine side of the `host` capability):

- Dial each linked sandbox — one outbound WebSocket, enrollment token in the first frame, oRPC after that; the
  machine *serves* `hostContract`, so no port ever opens here. Where it dials is the shared resolver's answer
  (below), re-asked on every reconnect, so a sandbox on this very machine stays connected with its tunnel down.
- Expose the tool surface (`run_command`, files, screenshot, `describe`; deliberately no delete — trash is
  recoverable) as MCP carried verbatim, so a machine can learn a tool without a daemon release.
- Enforce the owner's scopes **here**, never in the sandbox, and append every call to an audit log that
  survives uninstall.
- Manage this machine's sandboxes for a browser button or a model, under the `sandboxes` switch: list them
  with their **share of the machine** (one `docker inspect` per listing: memory and CPU caps, privileged, GPU,
  and who asked for each directive, the approved environment or the owner), start/stop/restart, run the `ic`
  flows (prepare, update, rebuild, rollback, reshape, remove) narrating their output line by line, and tail
  their logs. `reshape` changes a sandbox's share or privileges through `ic sandbox reshape` on the same
  switch as the swaps, because another reshape undoes it; its ask is a closed form (two caps, two switches)
  spelled into `ic` flags here, so nothing a browser or a model sends reaches docker as text. `describe`
  reports the docker engine's size beside the OS, which is the ceiling those caps are held to.
- Keep each local sandbox's **next update downloaded** (`src/device/auto-prepare.ts`): a background tick
  runs `ic sandbox prepare <slug> --auto` every few hours, so the web app's update card offers a half-minute
  restart instead of minutes of pulling. On by default; the switch is `intentic-machine device updates
  --off` (cached in `device.json`). Nothing in any sandbox can start or steer the tick — a sandbox only
  learns the outcome through the staged marker `ic` writes, the way it always has.

The **sync half** (`src/sync/`, the machine side of desktop sync):

- Enroll an SSH key, then drive Mutagen: bidirectional file sync of a local folder ↔ the sandbox's /work, plus
  a one-way backup of the sandbox's own state.
- Serve the SSH transport itself on loopback (the sandbox's sshd reached over its HTTPS surface), mirror every
  workspace port onto this machine's localhost, and bridge git so commits appear in local clones.
- Own the **port-mirroring switch** (`sync mirror off|on`, optionally `--sandbox <id>`): mirroring is the one
  thing here that writes to *this* device's localhost, so the flag lives on this side, survives a restart, and
  is read every tick. File sync, the state backup and the git bridge are untouched by it — the point is to stop
  the ports without unpairing the sandbox. The sandbox's Devices tab has a button for it, and that button runs
  this very command over the `host` capability, so the two can never disagree. The same is true of the other
  three verbs — `sync pause`, `sync resume` and `sync uninstall --sandbox <id>`.

  **Both scopes are buttons, because both scopes are commands.** With `--sandbox` these act on one pairing, and
  that is the switch under that pairing's own folder and ports in the tab. Run BARE they act on every sandbox
  this machine pairs, which is what they mean in a terminal and what "turn this off on this laptop" should mean
  on screen, so the machine's own row carries a **File syncing** and a **Port mirroring** switch that omit the
  flag. The tab never sends a bare `sync uninstall`: unpairing is the one verb here that a fresh one-liner is the
  only way back from, so the button always names the pairing it ends. A machine whose pairings disagree (one
  mirroring, one not — which the per-pairing switches exist to allow) is drawn as such rather than collapsed to
  one position, and offered both directions.
- Register Mutagen's daemon for login autostart — on Windows through the launcher stub, because Mutagen's own
  registration flashes a console window at every boot.

**Shared** (`src/`): the one resident loop (`run`), the merged `status` (and its `--json` envelope the desktop
app's tray reads), self-`upgrade` with automatic rollback, the autostart spec, and **where a sandbox's daemon is
dialled** ([src/daemon-base.ts](src/daemon-base.ts)). A sandbox usually runs in a container on this very
machine, which publishes its daemon on `127.0.0.1:<port derived from the sandbox id>`, so every dial either half
makes — the device socket, both enrollments, the sync transport, the ports poll, the machine report — tries
that address first and the public URL last. A candidate is adopted only if the daemon's unauthenticated
`/health` answers with the id we expected: a port is not a sandbox, and a token is what would be presented to
whoever holds it. For the sync half the shortcut saves a multi-gigabyte Mutagen sync a trip out to the
reachability edge and back to the same laptop. For the device half it is reachability itself: the socket used
to dial the public URL and nothing else, so a sandbox whose tunnel was down read "offline" on its own Devices
tab, with every button there gone, while this same process was polling it over loopback. The watcher re-probes
a pairing sitting on the public URL each minute, so a container started later is promoted with no restart; the
socket re-resolves on every reconnect.

## The resident loop

`intentic-machine run --foreground` (what systemd, launchd and the Windows launcher stub run) serves both
halves in one process ([src/resident.ts](src/resident.ts)):

- The sync half re-reads its pairing list every tick; the device half's link list is fixed at startup, which
  is why every `setup`/`uninstall` restarts the loop (`reconcileResidency`) instead of poking it.
- The process exits — and takes the login entry with it — only when **both** halves have nothing to serve.
- On a signal it exits `128+signal`, never 0: a supervisor must restart what it did not stop, and the incident
  that bought that rule is written out in [src/sync/mirror.ts](src/sync/mirror.ts).
- It stamps **the build it is running** into its pidfile (`pid boot build`). Nothing else knows it: replacing the
  binary does not touch the process, so a machine can hold a current agent and keep serving a months-old one.

### Installed vs running

Two facts, and every surface now carries both. `agents.sync` in the machine report is the **file** at
`bin/intentic-machine` ([src/installed.ts](src/installed.ts)); `watcher.build` is the **loop** running from it.
They drift whenever a binary lands without a restart — a card's one-liner re-run, a copy dropped in, an upgrade
in one environment while the loop runs in another — and the gap used to be invisible: whichever process built the
report stamped its own version into the one field, so the same machine answered its running build to the sandbox
its loop posts to and its installed build to one reading over a `host` capability.

- `intentic-machine status` says which is which, and the summary the tray reads leads with `OLD BUILD RUNNING`.
- The Devices row says it beside the pid, with the two commands that close it.
- `intentic-machine upgrade` restarts a loop that is behind the installed binary even when there is nothing to
  download, and after a swap it verifies that the loop which came up **is** the new build rather than that some
  process is alive — the check the old agent passed just as well as the new one.
- A loop already on the installed build is never bounced, and a loop that is stopped is never started: `run
  --stop` is a thing people do on purpose.

## Key files

- [src/commands.ts](src/commands.ts) — the CLI surface: `device setup|uninstall|updates`, `sync setup|pause|resume|mirror|uninstall`, shared `run|status|version|upgrade|uninstall`.
- [src/install.ts](src/install.ts) — what every `setup` runs first: self-update (then re-exec), PATH repair, the Windows launcher stub. Everything the install scripts used to decide, decided once here.
- [src/upgrade.ts](src/upgrade.ts) — `upgrade`: what is published, then download → probe → stop → swap → start, with a rollback behind every step, and a restart when the file is current but the loop is not.
- [src/installed.ts](src/installed.ts) — which build the *file* at `bin/intentic-machine` is, as opposed to the one running: free while the two agree, one probe per swap after they stop.
- [src/daemon-base.ts](src/daemon-base.ts) — where a sandbox's daemon is dialled, for both halves: loopback first when `/health` proves it is ours, the public URL as the floor.
- [src/resident.ts](src/resident.ts) — the one loop, its pidfile, and `reconcileResidency`.
- [src/device/auto-prepare.ts](src/device/auto-prepare.ts) — the background update-download tick; the judgement about *what* to download stays in `ic sandbox prepare --auto`, on purpose.
- [src/status.ts](src/status.ts) — both halves as one answer; `--json` is what the desktop app and tray read.
- [src/device/policy.ts](src/device/policy.ts) — what the sandbox is permitted to do here; the security surface.
- [src/device/tools/sandboxes.ts](src/device/tools/sandboxes.ts) — the fleet: the `docker ps`/`inspect` readers, the docker verbs, and the `ic` flows (swap, reshape, remove, runners) with the pure argv builders beside them.
- [src/sync/mirror.ts](src/sync/mirror.ts) — the sync tick: ports reconcile, git bridge, revocation handling.
- [src/sync/mutagen.ts](src/sync/mutagen.ts) — driving the Mutagen binary, sessions and its daemon's autostart.

## How it fits

Runs on the user's machine, not in the sandbox. Installed by `device.{sh,ps1}` / `sync.{sh,ps1}` (both cards
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
[`_devices/win-launcher`](../win-launcher)'s.

## Conventions & gotchas

- **Bidirectional sync has no undo.** The integration tests here run against real directories and a real
  Mutagen for exactly that reason; a unit test that mocks the sync proves nothing about the case that loses work.
- **The two halves keep separate state files** (`device.json`, `sync.json`) in the one home: the loop rewrites
  one half's state while a concurrent `setup` writes the other's, and separate files make cross-half torn
  writes impossible rather than unlikely.
- **Scopes are a cache.** The sandbox pushes the real grant on every connect; what is stored only governs the
  seconds before the first push, and it starts at everything-off.
- **The transport lives in the resident loop**, so `sync setup` starts the loop *before* it probes ssh or hands
  anything to Mutagen: every step after that one needs the port to be open.
