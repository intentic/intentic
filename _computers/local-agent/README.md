# @intentic/local-agent

The plumbing every intentic CLI that lives on a **user's own computer** needs, and none of what any of them does.

```
~/.intentic/<name>/          agentHome(name)      — state dir + config.json
        config.json          writeSecretFile()    — 0700 dir, 0600 file
        <agent>.log          spawnDetached()      — the loop's output has nowhere else to go
        <agent>.pid          livePid()            — find the loop again from another process

HKCU\…\Run                   registerAutostart()  — Windows, per-user, no elevation
~/Library/LaunchAgents/      registerAutostart()  — macOS, opt-in per agent
~/.config/autostart/         registerAutostart()  — Linux desktop session
```

## Why it exists

Three agents ship to a user's machine and have nothing in common except how they are **installed** and how they
**stay alive**:

| | what it does | uses |
| --- | --- | --- |
| [`@intentic/host`](../../_computers/host) | lets the sandbox's agent work on this computer | home, launcher, autostart, detached |
| [`@intentic/sync`](../../_sandbox/sync) | mirrors files and ports between machine and sandbox | home, launcher, autostart, detached |
| [`@intentic/acp-bridge`](../../_sandbox/acp-bridge) | lets an editor talk to the sandbox | home |

They were written months apart, and each copy of that plumbing was made from the last one — a shape with a known
ending. The second copy is a snapshot of the first on the day it was taken, and every fix after that lands in
only one of them. It already had:

- **sync wrote its token file world-readable.** Its config module was copied from host's *before* the 0600 floor
  was added there, and nothing afterwards compared the two.
- **host has no macOS autostart.** It was copied from a sync that did not have one yet, and on macOS it wrote an
  XDG entry that nothing reads.
- **The Windows console rule, the compiled-binary argv rule and "report what the tool actually said"** were each
  written out at length in two files, in prose, cross-referencing the other agent by name — including in
  ARCHITECTURE.md, which said host's spawns behave "for the reason `@intentic/sync` documents".

This package is those lessons as code, so the fourth agent inherits them by importing rather than by reading.

## The four pieces

**`home.ts`** — `agentHome(name)` gives `{ dir, configPath }` under `~/.intentic/<name>`; `writeSecretFile`
writes through a 0700 directory to a 0600 file. Both modes are re-applied on every write, because `mkdir` does
not tighten a directory that already exists — an agent installed before this floor existed would otherwise keep
its old permissions forever.

**`launcher.ts`** — `cliLauncher(cliName)` answers how to re-invoke this CLI. The subtlety is the compiled
binary: `bun build --compile` reports an `argv[1]` inside its own virtual filesystem and re-injects it on every
launch, so passing it again shifts the command to `argv[2]` where the parser never looks.

**`autostart.ts`** — `registerAutostart(spec, launcher, log)` against an `AutostartSpec` the agent declares.
Windows gets the **detached** command (Explorer starts a Run entry in the interactive session, where the
foreground loop would park a black console window on the desktop from login until shutdown); launchd and the
desktop session, which supervise what they start, get the **foreground** one. `launchAgent` is optional — an
agent that has not been exercised on macOS says so and gets a note, rather than a file macOS never reads.

**`detached.ts`** — `spawnDetached`, `livePid`, `isProcessAlive`, and the flag that is the opposite on each
platform: POSIX wants `detached` (its own session), Windows wants `windowsHide` (a console with no window, which
every descendant inherits). The two cannot be combined — `CREATE_NO_WINDOW` is ignored alongside
`DETACHED_PROCESS` — so passing both is exactly passing neither, which is how three black windows came to pop up
every five seconds on an idle machine.

## What this package is not

It knows nothing about sandboxes, tunnels, enrollment or MCP. It takes a name, a launcher and a spec, and makes a
CLI survive a reboot with its credentials readable only by its owner. *What* the agent then does is the agent's
business — which is why host's scopes and sync's Mutagen sessions are nowhere near here.

## Key files

- [src/index.ts](src/index.ts) — the public surface.
- [src/home.ts](src/home.ts) — the `~/.intentic/<agent>` directory and its 0600 floor.
- [src/autostart.ts](src/autostart.ts) — login autostart, per platform.
- [src/detached.ts](src/detached.ts) — the background loop, and surviving a closed terminal.
- [src/launcher.ts](src/launcher.ts) — `cliLauncher()`, including the compiled-binary argv case.
