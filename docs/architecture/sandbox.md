# The sandbox daemon

The Node process inside every sandbox that owns the workspace, runs each agent conversation in its own git worktree, lands the result onto the main tree, and keeps its records beyond the agents' reach.

```mermaid
flowchart LR
    editor["Editor"] --> front["intentic-front<br/>ports · tunnel"]
    front -->|"Unix socket"| daemon(["daemon<br/>src/main.ts"])
    daemon --> actor["one actor per<br/>conversation"]
    actor --> runtime["runtime adapter<br/>Claude · Codex · ACP …"]
    runtime --> wt["worktree<br/>/history/worktrees/id"]
    wt -->|"land: patch as<br/>uncommitted changes"| main["main tree<br/>/work"]
    main --> verify["land check<br/>verify-deps.ts"]
    verify -->|"red"| route["who fixes it<br/>land-breakage.ts"]
```

## The process

- `docker-entrypoint.sh` starts sshd, then [`intentic-front`](../../_sandbox/front) (Rust), which owns every port and the ingress tunnel and supervises `node dist/main.js`. The daemon listens only on a Unix socket, so a daemon restart drops no connection.
- [`main.ts`](../../_sandbox/sandbox/src/main.ts) loads config, builds every service in [`composition.ts`](../../_sandbox/sandbox/src/composition.ts), runs the boot steps and opens the readiness gate.
- The wire is the oRPC contract in [`_shared/sandbox-contract`](../../_shared/sandbox-contract) (one `*.contract.ts` per route group), served by [`router.ts`](../../_sandbox/sandbox/src/router.ts). `/events` and `/agent/attach` stream; the browser view is a WebSocket opened with a one-shot ticket. The daemon does not serve the editor itself.
- Terminals are served by intentic-front, one tmux control-mode client per session shared by every viewer, over a WebSocket or a stream of the editor's WebTransport session ([`term/`](../../_sandbox/front/crates/front/src/term/mod.rs)); the daemon only answers whether a socket may open and onto what ([`terminal-plan.ts`](../../_sandbox/sandbox/src/terminal/terminal-plan.ts)).
- The file tree is held in memory by the workspace watcher's thread ([`resident-tree.ts`](../../_sandbox/sandbox/src/workspace/files/resident-tree.ts)) and re-listed only in the folders a batch touched; the tree route answers from it, and `/events` carries each batch as a `treeChanged` delta tabs patch their tree with.

## Agents

- A conversation is the durable unit and a turn is one run inside it. One actor per conversation ([`conversation-actors.ts`](../../_sandbox/sandbox/src/agents/actor/conversation-actors.ts)) decides whether a new message starts a turn, steers the running one, or waits in the queue.
- [`runtime-table.ts`](../../_sandbox/sandbox/src/runtimes/runtime-table.ts) picks an adapter per provider and harness: the Claude Agent SDK, Codex, OpenCode, Cursor, ACP agents and pi. What each runtime supports is declared in [`agent-runtimes.ts`](../../_shared/sandbox-contract/src/models/agent-runtimes.ts), so the editor never offers a control the runtime would ignore.
- A turn runs detached from any client ([`turn-runs.ts`](../../_sandbox/sandbox/src/agent/run/turn/turn-runs.ts)). It is journaled in `/history/conversations.db` and resumed after a restart; transcripts live in `/history/conversations/<id>/`.

## Worktrees

- An isolated conversation works on branch `agent/<id>`, with one git worktree per repository under `/history/worktrees/<id>/` ([`worktrees.ts`](../../_sandbox/sandbox/src/agents/worktrees/worktrees.ts)). Parallel agents cannot collide.
- Where the runtime supports it (`isolation: "namespace"`), [`isolation.ts`](../../_sandbox/sandbox/src/agents/worktrees/isolation.ts) binds the worktree over `/work` in a mount namespace and puts the real tree at `/mnt/intentic-main`; other runtimes only start in the worktree. `node_modules`, `.venv` and `dist` are overlay mounts of the main tree's, so a worktree needs no install.

## Land

- Landing applies a conversation's changes to the main tree as **uncommitted changes**. `HEAD` never moves; the owner's commit is the review boundary ([`land.ts`](../../_sandbox/sandbox/src/agents/land/land.ts), `landAgent`).
- It rebases the branch onto main ([`sync.ts`](../../_sandbox/sandbox/src/agents/land/sync.ts)), reconciles the lockfile, and checks every repository's patch before writing any: one conflict and nothing is written. The `merge` mode writes conflict markers instead, and `measure` is a dry run.
- After a land, [`verify-deps.ts`](../../_sandbox/sandbox/src/workspace/deps/verify-deps.ts) runs the repository's `land` check, else its `verify` script, else `test`, on the main tree in the background. It is the one check work gets, and nothing waits on it. One project is checked at a time, and lands that arrive during a run wait and are measured together in the next. `GET /workspace/mainline` ([`mainline-status.ts`](../../_sandbox/sandbox/src/workspace/deps/mainline-status.ts)) is what the editor shows of it: the Main line in the Agents board's status bar (what waits, what is being checked, each project's last verdict, who is working on a red one, and what pushes left behind) and a status on each session card.

## After a red land check

[`land-breakage.ts`](../../_sandbox/sandbox/src/agents/land/land-breakage.ts) routes a red run the same way every time, in this order:

1. More work landed while it ran: wait for that check, which may already be green. At most three times per red streak.
2. A conversation still working has unlanded changes in a failing package: hold, tell it once, and route when it stops or after 45 minutes.
3. Lay the failures at a land: the one land the run covered, else the lands whose changed paths share a package with a failure. Nothing is re-run to tell several suspects apart: one fresh conversation handed all of them costs less than a test run per suspect on a shared machine.
4. Exactly one land named, and its conversation still has the work in mind (prompt cache warm, under 60% of its context window, not archived, sent fewer than two times this streak): send the failures back to it.
5. Otherwise start a fresh fix-up conversation ([`land-fix.ts`](../../_sandbox/sandbox/src/agents/land/land-fix.ts)) with the failures, each suspect's changed files, the exact `git diff <from> <tip>` and `agents show <id>` to read its conversation. Its id is `land-fix-<project>-<streak>`, so every attempt at one streak shares it, and a streak gets at most two attempts.
6. Past those limits the red waits for a person.

Every decision is filed on the run and shown in the editor. With the owner's "Repair what breaks after landing" switch (`autoRepair`) off, all of it is only reported. A red streak's end logs `mainline: red streak ended` with how long it lasted.

## What a push left behind

The pre-push hook reports and never refuses, so what it finds has to outlive the terminal it printed to. The hook leaves a report in the repository's git common dir (`intentic-push-report.json`, written by [`push-report.mjs`](../../_tools/scripts/verify/push-report.mjs) in this repository). The report holds the findings the push itself brought in, a measurement of every check and the linter, and the command that measures them again. [`push-checks.ts`](../../_sandbox/sandbox/src/workspace/deps/push-checks.ts) files the report into `.intentic/records/push-checks.json` when the push moves a remote-tracking ref, and only once the pushed head is on that ref, so a refused push leaves nothing behind. `GET /workspace/mainline` serves the report as `pushes`, and the editor shows the open findings amber as "Left at push".

- A finding stays open until a measurement no longer prints it or the owner dismisses it. Three measurements count: every later push, a recheck on the owner's press, and a recheck after each land check in a project that still has open findings. A landed fix therefore clears its findings minutes later.
- Nothing is sent anywhere by itself. This is unlike a red land check: the push already went and the tree still works, so the owner chooses when to act. "Hand to an agent" (`POST /agents/push-fix`, [`push-fix.ts`](../../_sandbox/sandbox/src/agents/fix/push-fix.ts)) opens one isolated conversation with every open finding in the project. The oldest push that still has an open finding sets its id, so pressing again continues the same attempt.
- Some findings are not recorded: the ones the hook calls already failing before the push, and the ones the base could not be asked about. Findings from the assertion ratchet, the lockstep and rustfmt are about commits that are already pushed, so no recheck can clear them. They end only when dismissed.

## Checks

- A repository declares its checks in `.intentic/checks.json` for the moments `edit` and `land` (`RepoChecksFileSchema` in [`settings.ts`](../../_shared/sandbox-contract/src/schemas/settings.ts)). The owner adopts the file, and a changed declaration waits for re-adoption. The `turn` moment is retired: a declaration naming it still parses and counts toward adoption, but runs nothing.
- [`repo-checks.ts`](../../_sandbox/sandbox/src/rules/repo-checks.ts) turns edit checks into `file.edited` rules. They run on every file an agent writes, and their output returns in that edit's result without stopping the turn ([`file-edited.ts`](../../_sandbox/sandbox/src/rules/file-edited.ts)).
- Nothing runs when a turn ends, nothing sends it back to work, and no check holds its land. The owner's `turn.ending` rules and the built-in `verify-ui-edits` are retired like `turn`. What a turn showed of its own work is recorded as its card's `proof` ([`turn-settlement.ts`](../../_sandbox/sandbox/src/agent/run/settle/turn-settlement.ts)): verified, unproven, failing or no-code from the checks it chose to run after its last edit, and how many rendered interface files it changed without looking. The editor badges it.
- A "Checks after landing" note ([`mainline-note.ts`](../../_sandbox/sandbox/src/workspace/deps/mainline-note.ts)) tells each conversation that nothing checks its work when it finishes, what runs after it lands, and which failures main already has. It goes out with the opening message, after a compaction, and whenever the main tree's reds change.

## Heavy work elsewhere

- Every agent command is sorted by the heavy-command rules ([`heavy-commands.ts`](../../_sandbox/sandbox/src/platform/resources/heavy-commands.ts), `.intentic/config/heavy-commands.json`): a matched one waits for a slot (`bin/queue-run`), and `bin/tmux-run` ends everything it started, in every process group, when it returns.
- The owner can send a kind of heavy work, and the check after landing, to a runner on one of their machines instead (settings `offload`, Agent → Tools → Where heavy work runs). The Bash hook and [`verify-deps.ts`](../../_sandbox/sandbox/src/workspace/deps/verify-deps.ts) then put `bin/offload-run` where the queue went, holding the queue's own prefix for when the runner cannot take it.
- `offload-run` snapshots the repository's working tree as one commit under `refs/intentic-offload/<run>`, uncommitted and untracked work included, and relays the run through [`offload.routes.ts`](../../_sandbox/sandbox/src/offload/offload.routes.ts) to the runner. The runner fetches it through the git door into `/history/offload/<repo>` ([`runner-command.ts`](../../_sandbox/sandbox/src/runners/runner-command.ts)), which it keeps between runs with its ignored files, reinstalls only when a lockfile or manifest moved, runs the repository's `offload:prepare` script when the tree changed, and runs the line behind its own queue. Output streams back as it comes; the exit brings every file the line changed as a patch, and the files it wrote to the variables asked for (the check's report, its tree verdict).
- A runner that is offline, predates offloading, stays full, or cannot fetch or install hands the line back, and it runs here with one line saying why. A line that resolved a secret never leaves.

## Priority and memory

- Every process the daemon starts for a purpose gets a workload class from whoever started it, never from its command line ([`workload-class.ts`](../../_sandbox/sandbox/src/platform/resources/workload-class.ts)). The class sets its niceness, its IO class and its `oom_score_adj`, and children inherit all three, so the whole tree carries it. When memory runs out the kernel takes, in order: builds a heavy-command rule matched (800), agent commands and dependency installs (600), services, gateways, backends and panels (500), then agent runtimes, 100 plus 100 per spawn level, so a child goes before its parent. The daemon and whatever it starts without a class stay at 0.
- `spawnAs` applies the class in the same call that spawns the child: runtimes (Claude, Codex, ACP, pi), service processes, the translator, the extension and browser backends. The iq engine is classed as it forks. A panel's or an install's pane shell is classed before the command is typed into it. An agent's command gets the class as a shell prefix (`nice`, `ionice`, `choom`) inside `tmux-run`. Process metrics still label processes by command line ([`process-scan.ts`](../../_sandbox/sandbox/src/platform/resources/process-scan.ts)), and that label ranks nothing.
- A turn is admitted against the sandbox's working set plus swap, measured against `memory.high` (the entrypoint sets it to 90% of the cap, and past it the kernel throttles the whole sandbox into reclaim), else `memory.max`, else the machine's memory ([`memory-admission.ts`](../../_sandbox/sandbox/src/platform/resources/memory-admission.ts)).

## State

| Place | Holds |
| --- | --- |
| `/work` | the repositories, visible to agents, on its own volume |
| `.intentic/config` | tracked configuration: settings, personas, skills, capabilities, the environment overlay |
| `.intentic/records` | ledgers: agent sessions, land verdicts, chores |
| `.intentic/local` | rebuildable caches and browser profiles |
| `.intentic/identity`, `.intentic/secrets` | owner, members and passkeys; credentials |
| `/history` | the conversation store, transcripts, worktrees, git directories, snapshots and logs |

`/history` is a separate volume outside `/work`, so no command in the workspace can erase the recovery record. [`workspace-state.ts`](../../_shared/sandbox-contract/src/state/workspace-state.ts) lists every state file and its group, and the file API refuses the daemon's own entries.

Every stored file is read by every later release, from sandboxes that skipped any number of them. Each is declared with the conversions its shape has had ([`documents.ts`](../../_sandbox/sandbox/src/store/evolution/documents.ts)); the stores run them on every read and keep what they do not know on writes, and the first boot after an update writes converted files back under a journal a rolled-back build undoes ([`state-convergence.ts`](../../_sandbox/sandbox/src/store/evolution/state-convergence.ts)). The promise and the rules for a change are in [COMPATIBILITY.md](../../COMPATIBILITY.md#stored-data).
