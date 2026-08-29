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

The **sync half** (`src/sync/`, the machine side of desktop sync):

- Enroll an SSH key, then drive Mutagen: bidirectional file sync of a local folder ↔ the sandbox's /work, plus
  a one-way backup of the sandbox's own state.
- Serve the SSH transport itself on loopback (the sandbox's sshd reached over its HTTPS surface), mirror every
  workspace port onto this machine's localhost, and bridge git so commits appear in local clones.
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

- [src/commands.ts](src/commands.ts) — the CLI surface: `computer setup|uninstall`, `sync setup|pause|resume|uninstall`, shared `run|status|version|upgrade|uninstall`.
- [src/resident.ts](src/resident.ts) — the one loop, its pidfile, and `reconcileResidency`.
- [src/status.ts](src/status.ts) — both halves as one answer; `--json` is what the desktop app and tray read.
- [src/computer/policy.ts](src/computer/policy.ts) — what the sandbox is permitted to do here; the security surface.
- [src/sync/mirror.ts](src/sync/mirror.ts) — the sync tick: ports reconcile, git bridge, revocation handling.
- [src/sync/mutagen.ts](src/sync/mutagen.ts) — driving the Mutagen binary, sessions and its daemon's autostart.

## How it fits

Runs on the user's machine, not in the sandbox. Installed by `computer.{sh,ps1}` / `sync.{sh,ps1}` (both cards
download the same binary into `~/.intentic/machine/bin`, plus `intentic-launch.exe` on Windows), shipped as a
bun-compiled binary per platform, self-updated by `upgrade`. The install-and-stay-alive plumbing is
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
