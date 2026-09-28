# machine

`intentic-machine`, the one agent on a user's own computer: it lets a paired sandbox work on the device under scopes enforced locally, and mirrors a sandbox's folder and ports onto it.

```mermaid
flowchart LR
    shim["Install one-liner<br/>from a sandbox card"] -->|"device setup, sync setup"| machine(["intentic-machine run"])
    machine -->|"outbound WebSocket"| daemon["Sandbox daemon"]
    daemon -->|"MCP tool calls"| policy["Scope check<br/>device/policy.ts"]
    policy --> local["Shell, files, screen,<br/>browser, local sandboxes"]
    machine -->|"Mutagen over tunnelled SSH"| daemon
    machine --> folder["Local folder<br/>and mirrored ports"]
    machine -->|"Windows only"| distros["Agent in each<br/>WSL distro"]
```

- One resident process per environment (`resident.ts`) serves both halves and re-reads its state every tick. A login
  entry from [local-agent](../local-agent) restarts it; inside a WSL distro the Windows side does.
- **device** (`src/device/`): `device setup` redeems a one-time pairing token, then the agent keeps a WebSocket
  dialled out to the sandbox and answers MCP tools on it: `run_command`, files, windows and clipboard, `browser_*`
  through [browser](../browser), `screenshot` and `device` through [desktop-automation](../desktop-automation), and
  the intentic sandboxes on this machine through the `ic` CLI.
- The sandbox tools are thin callers of `ic` ([`tools/sandboxes.ts`](src/device/tools/sandboxes.ts)): the listing is
  `ic sandbox list --json` passed through, and start, stop, restart, the swaps, `set-shape`, `forget-shape` and the
  logs are ic's own verbs, argv spelled by the contract (`icShapeArgs`, `icPowerArgs`). The shape reaches ic as the
  contract's own object (`--set memoryGib=12`), so no flag of ic's is spelled here; the old `reshape` op is carried
  out through the same verb. A rollback's `to` becomes `ic sandbox rollback <slug> --to <version>`. A sandbox an
  interrupted swap left parked is listed under its own slug and found like any other, so start, rollback and update
  reach it; a listing field a newer ic writes in a way this agent cannot read costs that field, not the whole
  listing. Nothing here runs docker or reads the shape saved for a sandbox's next restart; ic
  answers both. Before its first `ic` call the agent makes
  sure the installed `ic` is at least as new as itself, fetching its own release's into `~/.intentic/ic/bin` when it
  is not ([`tools/ic-binary.ts`](src/device/tools/ic-binary.ts)), since a new verb here arrives with a new verb there.
  A fetch that fails is logged with its reason and reported in the device's facts (`icOutOfDate`, beside `features`),
  so a stale `ic` explains why logs and saving a shape are missing; the next sandbox action tries again.
- **sync** (`src/sync/`): `sync setup` enrolls an SSH key and runs Mutagen against the sandbox's sshd, reached
  through a loopback port tunnelled over a WebSocket. It keeps a folder two-way synced, forwards every workspace
  port to the same localhost port, and fast-forwards local git clones from the sandbox.
- A **project pairing** (`sync setup --remote-dir /work/<name> --project`, what the desktop app asks for when it
  makes a sandbox for a folder the owner picked) syncs that folder with `/work/<name>` rather than `/work`, and nothing
  of the sandbox's is written into it: no state backup session, no git bridge, and an ignore list that keeps a
  project's own `.intentic/` and `refs/` ([`sync/config.ts`](src/sync/config.ts) holds a remote dir to those two
  shapes, and refuses `sync.json` whole otherwise). `setup` refuses a folder that is, holds or sits inside another
  sandbox's, and a set-up-again that would change where a paired sandbox's folder syncs.
- Only the resident agent creates Mutagen sessions: `setup` records the pairing and waits for the session to
  appear, since two creators racing left one name holding two identical sessions. The agent keeps one session per
  name, terminating any extras, and recreates a session whose rules drifted once there are no conflicts left.
- `setup` replaces what this agent's `known_hosts` holds for the pairing's alias (hashed entries included): with the
  host key the enrollment carries when it carries one (a sandbox reads its sshd's public key off its history volume and
  answers with it, `SyncEnrollmentAnswerSchema` in the contract), else with nothing, so `accept-new` records the key
  the sandbox presents now, as it does for an older sandbox. Outside an enrollment a changed key is still refused. A sandbox whose ports poll has failed for ten
  minutes has its forwards taken off localhost, and they come back with its first answer. `sync uninstall` stops and
  unregisters Mutagen's daemon only when it is this agent's own copy, never a Mutagen the user installed.
- Symbolic links travel only where the device can create them ([`sync/symlinks.ts`](src/sync/symlinks.ts)). A
  Windows PC without Developer Mode refuses every link, and Mutagen would try again on every cycle, so its sessions
  use `--symlink-mode ignore`. Turning Developer Mode on brings them back at the agent's next start.
- **Which computer this is** ([`machine-id.ts`](src/machine-id.ts)): a `machineId` minted once at install and kept
  in `~/.intentic/machine/machine-id`, sent in the connect-time facts, the sync report and the sync enrollment. The
  Windows side hands its own to the agent it starts in each distro, so every OS install of one PC answers with one id;
  a sandbox joins enrollments, sync enrollments and device rows on it, never on a hostname.
- The features a device advertises (`set-shape`, `reshape-later`, `rollback-to`) are read off the `ic` under it, from
  that `ic`'s own help (`ic sandbox shape --set` for the first two, `ic sandbox rollback --to` for the third), rather
  than listed beside the code. The device RPC inputs are strict, so an op or field this agent does not know is refused
  rather than dropped, and a `to` on anything but a rollback is refused. The one exception is the grant a sandbox
  pushes ([`device/grant.ts`](src/device/grant.ts)): a switch this agent does not know is left off and logged once per
  link, since refusing the grant dropped the link and the sandbox redialled it forever. A known switch with a value it
  has no meaning for is still refused. `reshape-later` and the old `reshape` op stay only for pages and daemons from
  before `set-shape` (v1.312.0 and older), and go in v1.314.0.
- Every path under the user's home goes through `homeDir()` from [local-agent](../local-agent), which follows a `HOME`
  set after startup; a test holds the sources to it.
- Scopes are enforced here and nowhere else: the sandbox only asks, and a refusal names the switch that is off.
  Files stay inside the configured roots, writes need their own switch, and every call is appended to
  `~/.intentic/machine/audit.jsonl`. While an agent drives input on Windows, a notice shows on screen and
  `PAUSE_HOTKEY` pauses every link.
- Every connection dials out; the only listeners are on loopback. One of them is short-lived: while a sandbox's
  sign-in is open, [`device/loopback-catch.ts`](src/device/loopback-catch.ts) listens on the
  `http://localhost:<port>/…` address the provider redirects to, the one a CLI running here would have held, and
  streams each landing back (`catchLoopback`, advertised as the `loopback-catch` feature). It checks nothing: the state
  and the PKCE verifier stay in the sandbox, which alone can tell the sign-in from anything else that hits the port. A
  taken port answers `busy`, and the sandbox leaves the paste to the person.
- On Windows the Windows side is the root of the PC (`src/environments/`): it holds one `wsl.exe` session per
  distro with an agent, and `upgrade` brings every environment to the same release. The root also updates itself
  on a timer and pre-downloads sandbox updates with `ic sandbox prepare --auto`.
- The install shims only put a first binary down and run `setup`; `install.ts` decides the rest. `status --json`
  is what the desktop app's tray reads.

### Upgrades that can be undone

- **A swap is never cut short by this agent.** `ic` runs in a process group of its own on POSIX, keeps its pipes, and
  is never killed when the link or request that asked for it goes away. Every restart of the agent (the auto-upgrade
  tick, `upgrade`, `run`, the browser's Update and Restart) waits while any channel record in this environment's ic
  home (`INTENTIC_HOME`, else `~/.intentic`) says `swap_phase=cutover` with `swap_at` in the last 30 minutes, or while
  this process runs a flow that moves a container ([`device/sandbox-rounds/swap-records.ts`](src/device/sandbox-rounds/swap-records.ts)); the tick
  looks again in five minutes, a command waits and says so.
- **The probation watch** ([`device/sandbox-rounds/probation-watch.ts`](src/device/sandbox-rounds/probation-watch.ts)) runs
  `ic sandbox watch <slug> --json` every minute for each sandbox whose record names a `swap_phase`, and
  `ic sandbox watch --json` over every sandbox half a minute after start (a reboot mid-swap) and every ten minutes.
  ic finishes or undoes an interrupted cutover and rolls a failing new version back; the agent logs what it did.
  The per-record watch runs in every environment, since only the environment that swapped holds the record; the sweep
  over every sandbox runs on the root only, as the daily jobs below do, because a WSL distro shares the Windows
  side's Docker engine.
- **Daily**, on the root: `ic sandbox backup <slug> --auto --json` for each running sandbox, one at a time, twenty to
  forty minutes after start and then every day, then one `ic sandbox tidy --json`, whose volumes nobody claims are
  named and never deleted. Both back off from a slug that keeps failing, as auto-prepare does, and each has its switch
  beside the update ones (`intentic-machine updates --backups off`, `--tidy off`).
- **File sync holds still while its sandbox is swapped here** ([`sync/swap-pause.ts`](src/sync/swap-pause.ts)). A
  pairing's local slug is the first label of its sandbox's public hostname (what ic names a sandbox with one) or the
  id in it (what ic names one from its connect token), so the mapping is exact. Its sessions are paused through the
  cutover and the first quarter hour of probation, and past that while the sandbox does not answer, then resumed; a
  pause somebody made is left alone. Only this environment's records count: a distro syncing a sandbox the Windows side
  swaps is not paused.
- **A self-update is kept undoable** ([`agent-trial.ts`](src/agent-trial.ts)). The replaced binary stays as
  `<bin>.previous` until the new agent has run for ten minutes and written its "healthy since" marker. Three starts of a
  release within ten minutes, none ended by a stop, restart or upgrade, put `.previous` back (at that start, or at the
  next upgrade pass) and record the release as `skippedAgent` in `machine.json`: neither the auto-upgrade nor an
  `upgrade` moves this environment onto it again until a newer one is published (`upgrade --force` does). A restart
  that throws during an upgrade puts the old binary back too.
- **What the agent leaves behind.** Under a systemd user unit the default `KillMode` ended the unit's whole cgroup on
  every `systemctl stop` and every agent exit, `ic` mid-swap included: the unit now says `KillMode=process`, and a
  unit an older build wrote is rewritten at the agent's next start, since a repair now replaces an entry that starts
  this same agent with other settings. What outlives the agent on purpose is `ic` (bounded by its own swap), Mutagen's
  daemon and the browser it opened; what must not, the agent ends itself: every `run_command` group still running
  when it stops, and on Linux the groups a crashed agent left, which the next agent ends at its start
  ([`tools/command-ledger.ts`](src/device/tools/command-ledger.ts)). The login entries of the two agents this one
  replaced on 2026-08-29 (`intentic-host`, the sync mirror) are removed once, at start.
- `intentic-machine sandbox <verb> [slug]` passes `list`, `start`, `stop`, `restart`, `update`, `rollback [--to]`,
  `versions`, `logs`, `doctor`, `watch`, `backup` and `backups` straight to ic, in this terminal, with ic's exit code:
  a sandbox can be looked at and repaired from here when no browser reaches it.

## Key files

- [src/commands.ts](src/commands.ts) — the CLI: `device`, `sync`, `sandbox`, `run`, `status`, `upgrade`, `updates`, `uninstall`.
- [src/resident.ts](src/resident.ts) — the resident process that holds links, pairings and WSL distros.
- [src/device/mcp.ts](src/device/mcp.ts) — every tool a sandbox can call on this device.
- [src/device/policy.ts](src/device/policy.ts) — scope checks and the file-root boundary.
- [src/sync/tunnel.ts](src/sync/tunnel.ts) — the loopback SSH port that fronts the sandbox's sshd.
- [src/environments/machine.ts](src/environments/machine.ts) — the Windows root and its WSL children.

## Commands

```sh
pnpm --filter @intentic/machine test
pnpm turbo run build --filter=./_devices/machine
node _devices/machine/dist/cli.js status
```
