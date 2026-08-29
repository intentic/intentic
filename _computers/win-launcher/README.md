# intentic-launch

The ~200 KB Windows program that starts another program without putting a window on anybody's desktop.

Everything the machine-side agent leaves resident — [`@intentic/machine`](../machine)'s one loop (sandbox
connections + the mirror watcher), and Mutagen's daemon beside it — has to come back after a reboot,
and on Windows that means a per-user `HKCU\…\Run` value. Explorer starts one in the interactive session, and
the loader gives a console to any program whose PE subsystem says CONSOLE. Both are console programs. So every
boot showed a black window for one to two seconds per entry, on machines whose owners had asked to see nothing
at all.

This is the fix, and it is a whole separate executable because the property that fixes it is decided at link
time: a **GUI-subsystem** program is never given a console, so there is nothing to map. It starts the real
command with `CREATE_NO_WINDOW` and gets out of the way.

```
HKCU\…\Run\IntenticMachine
  → intentic-launch.exe --log %USERPROFILE%\.intentic\machine\machine.log
                        -- intentic-machine.exe run --foreground
```

## Why not something already on the machine

Measured on a Windows 11 desktop with Windows Terminal as the default console host, by enumerating top-level
windows every 25 ms across each launch:

| how the program was started | window on the desktop |
| --- | --- |
| console program, the way Explorer starts a Run entry | ~1.2 s |
| `powershell.exe -WindowStyle Hidden -Command <program>` | ~2.6 s |
| Task Scheduler logon task, InteractiveToken, console action | ~2.1 s |
| Task Scheduler logon task → hidden PowerShell → console program | ~1.5 s |
| **GUI-subsystem parent → child with `CREATE_NO_WINDOW`** | **none** |

`-WindowStyle Hidden` is the one worth knowing about, because it is what everyone reaches for and what this
repository's own CI-runner script rested on: it hides the console the PowerShell host owns, but under Windows
Terminal the window belongs to `WindowsTerminal.exe`, a different process that never sees the request. The same
fact rules out hiding the console from inside the agent through `bun:ffi`, and it is why Task Scheduler buys
supervision rather than silence.

`bun build --compile --windows-hide-console` does produce a GUI-subsystem binary, but that binary is 85 MB and
a GUI-subsystem CLI writes to no terminal — `intentic-machine status` would print into the void. Hence a small
program with one job, and a Rust crate with no dependencies at all: `std` has both halves (`creation_flags` for
the flag, a file handle for the child's stdio).

## What it gives the child

A console of its own with **no window on it**, which is better than the `DETACHED_PROCESS` a loop gets from a
terminal: a console child of a console-*less* process is handed a brand-new console, window and all, so every
`spawn` inside the agents has to remember `windowsHide`. A child of a process started here inherits a console
that has no window to show, and so does its children.

Two callers want opposite lifetimes, which is the whole of `--wait`:

- **An agent's Run value** wants this process gone at once. It exits after starting the loop and prints the
  loop's pid on stdout, for the caller that has a pipe on it (`spawnDetached`) and to nowhere at logon.
- **A Task Scheduler action** ([`setup-windows-runner.ps1`](../../_tools/scripts/setup-windows-runner.ps1))
  wants the opposite: a task counts as *running* only while its action process does, which is what makes
  `-MultipleInstances IgnoreNew` swallow watchdog repetitions and `Stop-ScheduledTask` reach what it started.
  `--wait` holds until the child exits and passes its exit code through.

`--log` is required. A program started from the Run key has no terminal, no parent waiting on it and no exit
code anyone will see, so the log file is the only surface on which "it did not start" can be a sentence rather
than an absence.

## How it ships

Built by [`build-win-launcher.sh`](../../_tools/scripts/build-win-launcher.sh) with the same cargo-xwin
toolchain as `ic`, Authenticode-signed like every other Windows artifact, attached to the GitHub release as
`intentic-launch-windows-amd64.exe`, and downloaded next to the agent by `computer.ps1` / `sync.ps1`. The agents
find it as a **sibling of their own executable** and nowhere else — never on `PATH`, which is not ours to trust
for deciding what starts a resident agent. An install without it still registers autostart, the old flashing
way, and says so.

## Key files

- [src/main.rs](src/main.rs): all of it — the parser, the spawn, and the measurements behind both.
- [Cargo.toml](Cargo.toml): no dependencies, and the size-first release profile that keeps it in the low
  hundreds of KB.
