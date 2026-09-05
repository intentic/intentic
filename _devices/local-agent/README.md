# @intentic/local-agent

The plumbing every intentic CLI that lives on a **user's own computer** needs, and none of what any of them does.

```
~/.intentic/<name>/          agentHome(name)      — state dir + config.json
        config.json          writeSecretFile()    — 0700 dir, 0600 file
        <agent>.log          spawnDetached()      — the loop's output has nowhere else to go
        <agent>.pid          livePid()            — find the loop again, pid + the boot it belongs to

HKCU\…\Run                   registerAutostart()  — Windows, per-user, no elevation, through the launcher stub
~/Library/LaunchAgents/      registerAutostart()  — macOS, opt-in per agent
~/.config/autostart/         registerAutostart()  — Linux desktop session

stdout                       createUi(process)    — the one renderer every agent speaks through
```

## Why it exists

Two agents ship to a user's machine and have nothing in common except how they are **installed** and how they
**stay alive**:

| | what it does | uses |
| --- | --- | --- |
| [`@intentic/machine`](../../_devices/machine) | lets the sandbox's agent work on this computer, and mirrors files and ports between the two | home, launcher, autostart, detached, ui |
| [`@intentic/acp-bridge`](../../_sandbox/acp-bridge) | lets an editor talk to the sandbox | home |

The machine agent's two halves (and the standalone host/sync agents they used to be) were written months apart,
and each copy of that plumbing was made from the last one: a shape with a known ending. The second copy is a
snapshot of the first on the day it was taken, and every fix after that lands in only one of them. It already
had:

- **sync wrote its token file world-readable.** Its config module was copied from host's *before* the 0600 floor
  was added there, and nothing afterwards compared the two.
- **host has no macOS autostart.** It was copied from a sync that did not have one yet, and on macOS it wrote an
  XDG entry that nothing reads.
- **The Windows console rule, the compiled-binary argv rule and "report what the tool actually said"** were each
  written out at length in two files, in prose, cross-referencing the other agent by name: including in
  ARCHITECTURE.md, which said host's spawns behave "for the reason `@intentic/sync` documents".
- **Each agent grew its own `out()` closure** writing straight to stdout, so every improvement to how one of
  them reads landed in exactly one of them: while the install a user actually experiences is `ic` and these
  agents in sequence, three voices deep.

This package is those lessons as code, so the fourth agent inherits them by importing rather than by reading.

## The five pieces

**`home.ts`**: `agentHome(name)` gives `{ dir, configPath }` under `~/.intentic/<name>`; `writeSecretFile`
writes through a 0700 directory to a 0600 file. Both modes are re-applied on every write, because `mkdir` does
not tighten a directory that already exists: an agent installed before this floor existed would otherwise keep
its old permissions forever.

**`launcher.ts`**: `cliLauncher(cliName)` answers how to re-invoke this CLI. The subtlety is the compiled
binary: `bun build --compile` reports an `argv[1]` inside its own virtual filesystem and re-injects it on every
launch, so passing it again shifts the command to `argv[2]` where the parser never looks. `windowsLaunchStub()`
finds the other half of a Windows install, [`intentic-launch.exe`](../win-launcher), sitting next to the agent's
own executable.

**`autostart.ts`**: `registerAutostart(spec, launcher, log)` against an `AutostartSpec` the agent declares.
launchd and the desktop session, which supervise what they start, get the **foreground** command. So does
Windows, but through the stub: `intentic-launch.exe --log <log> -- <agent> <foreground args>`. `launchAgent` is
optional: an agent that has not been exercised on macOS says so and gets a note, rather than a file macOS never
reads.

Windows earns that indirection. Explorer starts a Run entry in the interactive session, and the loader gives
every console-subsystem program a console — which on Windows 11, where the default console host is Windows
Terminal, is a terminal window on the desktop. The entry used to name the agent's own **detached** command,
which spawns the loop and exits, so what a user saw at every single boot was a black window for one to two
seconds. Nothing softer works: `powershell -WindowStyle Hidden` hides the console *its* host owns while the
window belongs to WindowsTerminal.exe, and a Task Scheduler logon task maps a window like anything else. Only a
program whose PE subsystem is GUI never gets a console, which is the whole of what the stub is. `detachedArgs`
remains the fallback for an install with no stub beside it (a developer running `node dist/cli.js`), and
registration says out loud that a window will flash.

**`detached.ts`**: `spawnDetached`, `livePid`, `pidFileBody`, `isProcessAlive`. On POSIX the loop is spawned
`detached` for its own session; on Windows because without it the loop is torn down the moment its parent
exits — measured on the compiled binary, and the reason "connected in the background (pid N)" was a lie there
for every release that passed `windowsHide` instead. The two cannot be combined to get both properties
(`CREATE_NO_WINDOW` is ignored alongside `DETACHED_PROCESS`), so a detached loop on Windows has no console at
all, and Windows hands a console child of a console-less process a new console *with a window*. That is why
every spawn inside a loop (git and ssh in sync's bridge, docker and PowerShell in host's tools) passes
`windowsHide` itself; the flag applies whether or not the parent has a console, where inheritance did not.

Where the stub is installed, `spawnDetached` goes through it on Windows and the bargain improves: the loop gets
`CREATE_NO_WINDOW`, so it has a console of its own with **no window on it**, and every console child inherits
that console instead of being handed a fresh one. The per-spawn `windowsHide` stays — it is what covers a loop
started any other way — but it stops being the only thing between a user and a black window. The stub prints
the loop's pid on its stdout, because its own pid belongs to a process that has already exited by the time the
settle check below would probe it.

`spawnDetached` also answers only once the loop has **survived** a short settle window, and throws naming its log
otherwise. A pid proves the OS created a process; every caller turns it straight into a sentence promising the
user their machine is now doing something.

A pidfile lives beside the config, so it **outlives the boot that wrote it**, while the number in it means
nothing outside that boot's process table: pids restart low and are handed out in roughly the same order every
time, so a loop's own pid from yesterday is somebody else's transient process this morning. So `pidFileBody`
writes the pid *and* a stamp naming the boot, and `livePid` ignores any record from a different one without
probing it. On Linux the stamp is `/proc/sys/kernel/random/boot_id`, exact and unmoved by the clock; elsewhere
it is the boot's epoch by subtraction from the uptime, which libuv takes from `GetTickCount64` on Windows and
`kern.boottime` on macOS — both keep counting across sleep, so a laptop that suspends goes on answering the same
boot. That derived form is compared with a two-minute tolerance, because it is anchored to `Date.now()` and a
stepped clock would otherwise read as a new boot; a false *mismatch* is the expensive direction, since it lets a
second loop start on top of a live one.

The cost of not doing this was measured: a machine bugchecked in standby, nothing removed the sync watcher's
pidfile, and on the next boot the watcher probed the pid it used to hold, found an unrelated early-boot process
wearing it, and refused to start. Refusing is deliberate and so exits 0 — a supervisor must not restart a
watcher into refusing again every `RestartSec` — which is precisely why `Restart=on-failure` never fired and
desktop file sync stayed off until somebody went looking.

**`ui.ts`**: `createUi(process)` is the whole of what an agent writes to a person, and the TypeScript twin of
`ic`'s `_sandbox/ic/src/ui.rs`. One question decides everything: is stdout a terminal. A **pipe** gets the
`intentic: [phase] message` marker stream and nothing else, because the desktop app parses it into a progress
bar and CI reads it out of a log: that shape is a contract, written down in
[docs/cli-output-protocol.md](../../docs/cli-output-protocol.md). A **terminal** gets a banner, a numbered
checklist with durations, one repainting status line and a ranked ending. And a third mode, **nested**, is what
makes an install read as one program rather than three: `ic` runs these agents inside its own checklist and
sets `INTENTIC_UI=nested`, so their output lands as detail under its step instead of opening a second banner in
the middle of somebody's setup.

The live region is deliberately **one line**, repainted with a carriage return. Redrawing a whole checklist in
place needs the cursor moved up N lines, which needs to know when a line wrapped: and these run under
`curl | sh` on terminals of unknown width. Everything already settled scrolls above it.

## What this package is not

It knows nothing about sandboxes, tunnels, enrollment or MCP. It takes a name, a launcher and a spec, and makes a
CLI survive a reboot with its credentials readable only by its owner. *What* the agent then does is the agent's
business: which is why host's scopes and sync's Mutagen sessions are nowhere near here.

## Key files

- [src/index.ts](src/index.ts): the public surface.
- [src/home.ts](src/home.ts): the `~/.intentic/<agent>` directory and its 0600 floor.
- [src/autostart.ts](src/autostart.ts): login autostart, per platform.
- [src/detached.ts](src/detached.ts): the background loop, and surviving a closed terminal.
- [src/launcher.ts](src/launcher.ts): `cliLauncher()` and the Windows launcher stub, including the
  compiled-binary argv case.
- [src/ui.ts](src/ui.ts), the renderer: the pipe/terminal/nested split, the checklist, the ranked ending.
