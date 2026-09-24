# Debugging the daemon from inside a dev sandbox

What an agent working ON this package can read, measure and run from its own shell, and where each answer lives.
Everything here is read-only against the running daemon unless it says otherwise.

## The records

| File under `/history/logs/` | What it holds |
| --- | --- |
| `daemon.log` | The daemon's own JSON lines. A line written during a turn carries `ctx.conversationId`, one written while serving a browser request carries `ctx.requestId` (the id the editor's `client.jsonl` reports use). |
| `perf.jsonl` | Only the spans over their slow floor (`src/platform/resources/perf.ts`), each with `load1` so a busy machine is separable from a slow op. The ranked summary is in `daemon.log` every ten minutes. |
| `resource-metrics.jsonl` | One sample a minute: memory, PSI, event-loop delay, processes by role, and each heavy-command pool with its `longestHolder`. |
| `client.jsonl` | What the editor reported about itself, warn and above. |
| `filter-stats.jsonl` | One line per agent Bash call: bytes in, bytes out, which output cleaner removed what. |
| `raw-output/` | The unfiltered output of a call whose footer named it; `retrieve-output <file> [pattern]` reads it back. |
| `terminals/` | Every tmux pane, VT-rendered by `pane-log-clean`. |
| `daemon-exit.json`, `report.*.json` | How the previous run ended; a fatal error leaves a Node diagnostic report beside it. |

Every file is trimmed to its newest whole lines once over its cap, so the first line always parses. The
`mcp__diagnostics__*` tools read the same files with a time window; `agents show <id> --transcript` reads one
conversation's record without walking `/history` by hand.

## Log level

`LOG_LEVEL` is read once at boot (`src/env.config.ts`); there is no runtime switch. At `debug`, every perf span is
also written as a trace line, which is the finest timing the daemon can give without a profiler.

## Profiling

- **A process you start**: `node --cpu-prof --cpu-prof-dir=/tmp/prof …` or `--heap-prof`, then
  `fileq read /tmp/prof/<file>.cpuprofile` for self and total time ranked by function. `strace -f -p <pid>` works, since
  the container runs as root with full capabilities.
- **The running daemon**: `kill -USR1 <daemon pid>` opens its inspector on `127.0.0.1:9229`. That changes a process you
  did not start, so ask the owner first. The daemon runs with `--report-on-fatalerror`, so a crash leaves a
  `report.*.json` under `/history/logs/` without asking anyone.

## Where a change runs

In a dev sandbox `/opt/sandbox/dist` is the HOST checkout's build, bind-mounted (`scripts/dev-mounts.mjs`); a build
inside `/work` never reaches the running daemon. The owner's `dev-restart` (`scripts/dev-restart.sh`, also a device
command) compiles on the host and restarts the container, which ends every running turn. To exercise a change without
that: the route and service tests stand the app up in-process (`createApp(services())`), `src/harness/e2e-harness.ts`
builds and runs the full image under testcontainers, and `_site/demo` serves the editor against a fake daemon.

## Tests

`pnpm test <path…>` (the package's `suites` script) runs only the test files whose path contains one of the
arguments, each under its own kind's budget. Without arguments it runs the whole package, about five minutes here.
Test and typecheck commands pass through the heavy-command queue and its memory gate, so on a loaded machine they
wait before they start; `resource-metrics.jsonl`'s `queue.<pool>.longestHolder` names what they wait behind.

## Waiting

A long command takes `run_in_background: true`; the turn is re-invoked when it exits, and the `wait` tool parks on it
(or on a child agent) by id. Something outside the sandbox (CI, a deploy) is watched with `mcp__watch__start`. A
`sleep` loop in Bash bills every poll to the turn.

## Network

`curl`, `ss`, `lsof`, `dig`, `nc`, `socat` and `openssl` are in the image. The daemon listens on `SANDBOX_PORT`
(8787); `/health` is open, and every other route needs a session. The per-boot agent token
(`/run/intentic/agent.token`, sent as `x-intentic-agent`) reaches only the routes the in-sandbox CLIs are declared
for. For the editor, the browser tools record the page's console and network (`browser_console_messages`,
`browser_network_requests`).
