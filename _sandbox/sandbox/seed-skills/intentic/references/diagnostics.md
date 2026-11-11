# Diagnostics playbook (read-only)

The daemon writes everything down. Ask the records instead of re-instrumenting code or reproducing. Load the tools
with `ToolSearch` `+diagnostics`; they read `/history/logs`, `/history/activity.jsonl` and the spend ledger over a
window you choose. They cannot write, and nothing in this playbook restarts anything.

The same queries answer from a shell as the `diagnostics` command (`diagnostics errors|timeline|turns|restarts|slow|resources|failures`,
`--help` for the flags), for every runtime and for a person in a terminal. `errors --from <ISO> --until <ISO>` reads the
log lines around a moment you already know, which a window reaching back from now cannot once the log has moved on.

## Gather

- Something happened to one conversation (yours, a subagent, a card on the board) → start with `agents show <id>`
  (what it was asked, how it ended, its branch, and a `now:` block for what holds it; `--transcript` for what was said,
  `--message <n>` for one message whole with its tool calls; the handle may also be a session-id prefix, a terminal log
  name, a run id or a subagent id; `agents find` also searches commands and question cards), then
  `mcp__diagnostics__timeline` with its `conversationId`: its daemon.log lines, activity entries (turn started,
  completed or failed, dependency checks, CI repairs, refused pushes), its turns and the daemon boots in between,
  oldest first. Use it instead of grepping `/history` for the id.
- Turns were interrupted, a session vanished, or the editor reconnected by itself → `mcp__diagnostics__restarts`: each
  boot, and whether the run before stopped cleanly or was killed, on which signal, and who asked for it.
- A turn failed, died, or answered with the wrong provider's error → `mcp__diagnostics__turns` (`only: "failed"`, or a
  `conversationId`): which model ran, the error code, the provider's own sentence.
- A turn changed code and ran no check after its last edit, or its last check failed → `mcp__diagnostics__turns` with
  `only: "unproven"`. That is the turn's own record, since nothing checks a turn when it ends or after it lands.
  Whether main passes is CI's answer for what the owner pushed: the **Pipelines** view, where a failing main shows the
  fix agent on it above the runs (`checks-and-ci.md`).
- A command keeps failing for agents (a tool that is not there, a script that needs a variable, a host it cannot
  reach) → `diagnostics failures`: every shell command an agent ran that failed, kept a month, grouped by program and
  error across conversations, each kind marked `ongoing`, `stopped` (its program has since run clean in two other
  conversations) or `quiet`, with what the agent ran instead. `--conversation <id>` lists one conversation's failures
  one by one. Only the shell command answers it; there is no `mcp__diagnostics__` tool for it.
- Something errored in the daemon (an automation, a sync, a land, a refused provider) → `mcp__diagnostics__errors`
  (`sinceMinutes`; `contains` a conversation id, route or code; `level`). Many matches come back grouped by message
  with a count and first/last time; `group: false` lists every line, `stacks: true` adds the stacks.
- The editor white-screened, stalled or felt slow → `mcp__diagnostics__errors` with `source: "browser"`.
- The editor names a route or a field it lacks, or a panel is blank → the daemon may be older than the app: compare
  `/opt/sandbox/package.json` with the newest release before suggesting a reload (`sandbox-behind-app.md`).
- Work felt slow → `mcp__diagnostics__slow` (`op: "git.run"` for one op exactly, `"git."` for every one under it;
  `groupBy: "op+path"` to split requests by route), with p50, p95, max and the machine's load at the worst one, which
  is what separates a regression from a busy machine. Those are only the spans over budget; for what is normal, or a
  performance audit over up to two weeks, add `source: "rollups"`: every span's count, total, failures and
  p50/p90/p99/max per op and subject.
- Out of memory, a killed process, a stalling event loop → `mcp__diagnostics__resources` with a field:
  `system.cgroup.event_oom_kill`, `processes.byRole.toolchain.rssBytes` (also browser, agentRuntime, localModel,
  container, searchEngine, terminal, languageServer, git, extension), `window.eventLoop.delayP99Ms`,
  `daemon.memory.rssBytes`, `system.pressure.memory.some`, `system.loadAverage`. A path naming an object or a list
  (`processes.top`) answers with its newest value.
- Output a command printed that the filter elided → its footer names the exact command:
  `retrieve-output /history/logs/raw-output/<log> [pattern]`.

Every answer names the file and window it searched and how far back the file reaches. An empty answer whose window
starts before the oldest line kept says nothing about that earlier time.

## Another sandbox's records

A bug the owner met in ANOTHER of their sandboxes is read from here, never by `docker exec` into its container:

- **Over a link that shares records.** The owner turns on "Share records" on that sandbox's inbound link (Access,
  Programs, Linked sandboxes); `agents links` says which links do. Then `agents ls|find|show|bundle … --on <link>` and
  `diagnostics … --on <link>` read its conversations, transcripts, log and diagnostics as its own agents would, with no
  turn started over there and nothing changed; the link's tool server has the same as `conversations`, `conversation`
  and `diagnostics`. Every conversation but a private one is readable, and each read is logged over there. No link yet:
  `capabilities request link --target <sandbox> --why "…"`; a link that does not share records answers so, and turning
  it on is that sandbox's owner's.
- **On one of the owner's computers.** When the sandbox runs on a connected device, `mcp__<device>__inspect_sandbox`
  runs its own `agents` and `diagnostics` read-only (`{slug, command: "agents", args: ["show", "<id>", "--transcript"]}`),
  with no link needed. `list_sandboxes` names the slugs.
- **From a file.** `agents bundle <id> --out <file>` there, or the editor's "Download debug bundle" on the conversation,
  puts its show, its record, its timeline, turns, log errors, restarts and the editor's reports in one JSON file; the
  owner attaches it to a chat here.

## Reading the files yourself

```
/history/logs/        daemon.log (+ daemon.log.1), perf.jsonl (slow spans only), perf-rollups.jsonl (every
                      span, as ten-minute histograms; older ones gzipped beside it), restarts.jsonl,
                      resource-metrics.jsonl, client.jsonl (what the editor reported about itself),
                      filter-stats.jsonl (what the output filter cut from each Bash call),
                      command-runs.jsonl (failed commands and each turn's clean runs; older ones gzipped beside it,
                      kept a month), raw-output/ (a
                      filtered call's whole output), terminals/ (every pane's lossless log)
/history/activity.jsonl                              turns started, completed or failed, CI repairs, refused pushes
/history/conversations/<id>/transcript.jsonl.zst     a conversation's transcript
```

Log lines are pino JSON, `time`, `level` (a label), `message` (not `msg`), `ctx.conversationId`, `ctx.requestId`,
`err`, so `jq -r .message`; `perf.jsonl` holds only the slow spans; transcripts read with `zstd -dc`, never with node's
`zstdDecompressSync`, which answers nothing on them.

## Mutate

Nothing. These are reads of the record of what happened.

## Report

Findings in causal order with the evidence line for each; the first failure at an owner boundary (a refused token, a
spent allowance, an outage, a persona's withheld power) named as such; then the next action, split into what you can
fix in the workspace and what is the owner's (a setting, a capability, a rebuild, a daemon restart from the host). Say
plainly that nothing was changed.
