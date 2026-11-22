# Heavy commands: builds, tests, a project's own heavy scripts, and timing runs

Every build, test run, typecheck and install an agent starts here takes its turn in one queue shared by every
conversation in this sandbox: the program is recognised as it starts (`cargo build`, `vitest`, `tsc`, `pnpm test`,
whatever line started it), waits for memory and for a slot, and then runs. Do not add `flock`, `nice`, `taskset`, a
`-j`, or a loop on `/proc/loadavg` or `free -m` to take turns by hand: the queue already does, across conversations you
cannot see.

## What the queue tells you, and what to do

- `[queue-run] <rule>: waiting for a free slot …, held by:` names who holds the slots (pid, conversation, command). It
  starts by itself; leave it, or run it in the background.
- `[queue-run] <rule>: waiting: a command that must run with nothing else heavy beside it holds this sandbox` is a
  project's exclusive job or a `quiet` run. It starts when that ends.
- `[heavy] cargo: -j 6 and 6 test threads (…)` is the parallelism the queue chose for a cargo build, check, clippy, doc
  or test from the cores the heavy slots share, what is busy now and the memory it was given. Pass `-j N`,
  `--jobs N`, `-- --test-threads=N`, or set `CARGO_BUILD_JOBS` / `RUST_TEST_THREADS` (or `[build] jobs` in the
  project's `.cargo/config.toml`) only when you need a specific number: yours always wins.
- `[memory-room] <rule>: holding it: 0.1 GiB free …` means the sandbox has less free than a person's turn needs, under
  which a heavy command is only started to be killed by the memory guard. It names the processes holding the most
  memory. Stop something of yours (a background job, a dev server) or wait; it starts by itself once there is room.
  At its ceiling it ends with `not started` and exit code 75: nothing ran, run it again later. Short of what it asks
  for but above that floor, it starts with what there is, and cargo sizes its jobs to it.
- `` … Priced at 11.2 GiB: `cargo test --lib -p integra-render` peaked at 9.7 GiB on its last run. `` at the end of a
  `[memory-room]` line means the command waited for more memory than its rule's price because the same command took
  that much before. The queue measures every command it starts (the whole tree of processes, so the test binary cargo
  runs counts) and prices the next run of the same command at its largest peak of the last five runs within two weeks,
  plus 15%, never more than the sandbox's memory. The same command means the same rule, repository, folder, program,
  subcommand and package or target selectors (`-p`, `--lib`, `--test`, `--workspace`, `--all-targets`, `--target`,
  `--release`, features). A test filter, `-j`, an environment variable, `timeout`, a redirection or a pipe does not
  make it a different command. There is nothing to do: the wait keeps other heavy commands from starting beside it,
  and such a command waits out its whole wait for room rather than starting short after 30 seconds, since it is known
  to be stopped by the memory guard when it does.
  If you made the command lighter, the old peak keeps pricing it until five newer runs or two weeks pass. Narrowing
  the command (`-p one-crate`, `--lib`) makes it a different command with a record of its own.
- `offload: running on <machine>, where the owner's Offloaded work setting sends <kind> commands` means the command
  runs on one of the owner's machines and its changed files come back. To run one here instead, behind this
  sandbox's queue: `INTENTIC_OFFLOAD=0 <command>`. Never set `INTENTIC_HEAVY_HELD`: it skips the queue itself, and
  your command then lands on the sandbox beside everything else.

The table of what counts as heavy is the owner's to tune in `/work/.intentic/config/heavy-commands.json` (only what
differs from the shipped rules; `ruleEdits` change a rule by its id, a declared class's included, or add one with a
`pattern`, which may be `exclusive`, `quiet`, `cpus` or `pin` like a class below).

## A project's own heavy commands: `<repo>/.intentic/heavy.json`

A script the project knows is heavy (a capture that renders the game in software, a render, an e2e suite) is declared
in the repository, beside `run.json` and `checks.json`, so it travels with the repo and binds every conversation. That
replaces a lock inside the script and "one at a time" prose in `AGENTS.md`:

```json
{
  "classes": [
    { "id": "motion-capture", "scripts": ["scripts/capture.py"], "memory": "6G", "cpus": 4, "quiet": true },
    { "id": "vfx-render", "scripts": ["scripts/vfxp/run.sh"], "memory": "4G", "group": "render", "exclusive": true },
    { "id": "e2e", "commands": ["npm run e2e"], "memory": "3G", "limit": 1 }
  ]
}
```

| field | meaning |
|---|---|
| `id` | lowercase letters, digits, dashes; names its rule, its pool and the lines the queue prints |
| `scripts` | repo-relative paths of the scripts it is, matched by file whatever runs them |
| `commands` | first words of the commands it is (`npm run e2e`, `make capture`, `cargo run --release --bin capture`) |
| `memory` | what it holds at its peak (`6G`, `512M`): the memory it waits for before it starts |
| `limit` | how many may run at once across the sandbox (default 1) |
| `group` | classes naming the same group share one pool, at the lowest limit among them |
| `exclusive` | nothing else heavy runs beside it: new heavy commands wait, and it waits for the running ones |
| `cpus` | cores it keeps busy: it starts once that many are idle (at most 2 minutes), and gets `INTENTIC_CPUS` |
| `pin` | with `cpus`, pinned to that many of the idlest cores |
| `quiet` | exclusive, and run as `quiet` runs (below) |
| `maxHoldSeconds` | how long it may run before it is stopped (default 1800); set it above a long capture's length |
| `onDeadline` | `skip`: never start beside what it waited for; it exits 75 instead (default `run`) |

A script is caught when run as `python3 scripts/x.py`, `python …`, `bash …`, `sh …`, `uv run …`, through `make`, by
node (`node scripts/x.mjs`), or as `./scripts/x.py` when its first line is `#!/usr/bin/env <interpreter>`; a script
whose first line names an absolute interpreter (`#!/bin/bash`) is caught only when started through one of those. It
says `[heavy] <id>: a heavy command this project declares …` as it queues. The daemon reads the file of every
repository in the workspace before each command, from the main tree; a class that does not parse is left out and
named in the daemon's log. Write it as an ordinary change to the repository.

## The quiet lane: `quiet -- <command>`

For a measurement of time (a benchmark, a profile, a capture whose frames must be steady):

```
quiet [--idle N] [--pin N] [--wait SECONDS] [--max-hold SECONDS] -- <command>
```

It waits for the heavy commands already running in this sandbox to finish and for the machine to be calm (`--idle`:
cores that must be idle, default three quarters of them), holds every new heavy command until it ends, optionally
pins the command to the `--pin` idlest cores, and prints the conditions beside the result:

```
[quiet] starting: 1.2 of 16 cores busy, load 3.1 4.0 6.2, pinned to cores 12,13. …
[quiet] exit 0 after 41.2s. Ran under: before, …; while it ran, everything else kept 0.4 cores busy (it used 3.9); after, load 4.1 …
```

After `--wait` (600 s) it runs anyway and says `NOT calm`: quote those lines with any number it produced. The load
is the whole machine's, other sandboxes on it included, which this sandbox cannot hold off.
