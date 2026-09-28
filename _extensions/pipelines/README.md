# pipelines

The Pipelines rail view: CI runs from the workspace repositories' GitHub and GitLab remotes on one board, a failing main line with the one fix agent on it, and rerun, cancel and fix actions.

```mermaid
flowchart LR
    vendor["GitHub · GitLab CI"] -->|"webhooks · backfill"| daemon["Daemon ci routes"]
    daemon --> ext(["pipelines<br/>browser"])
    ext -->|"rerun · cancel · jobs · fix"| daemon
    daemon -->|"fix"| agent["Fix conversation"]
    ext --> badge["Rail badge<br/>failing branches"]
```

- Runs in the browser, compiled into the editor app as a builtin. It holds no CI state: runs, jobs and main's failures come
  from the daemon's `ci` procedures, which keep them fresh from vendor webhooks and backfill when stale.
- The tile appears only when a GitHub or GitLab `cli` capability is connected. The board shows the open project's
  repositories, ranks them by how loudly they ask (`src/repoStandings.ts`) and draws each run's jobs as a layered graph
  (`src/graph/pipelineDag.ts`).
- A failing main-line branch says so once, in one compact banner at the head of its repository's runs
  (`src/fixes/MainFailureBanner.vue`): the branch, since when, a few of the jobs failing now, and on the same line who
  has it. While the one fix agent the daemon put on it at the first failed job works, the banner shows its live stance
  and asks nothing; every later failure on the branch goes to that agent until a run passes. Once the daemon hands it
  back (its turns spent, it stopped or finished without a fix, or repairs are off) the banner says "Needs you" with a
  two-word reason from the contract's `MainFailureHandBack` and offers one press, which gives the agent its turns back.
  It never shows the daemon's sentence or a turn's error: those are in the agent's conversation. The agent is joined by
  the id the failure names (`fixer`), never by a later run's derived id (`src/fixes/mainFailures.ts`).
- The badge counts branches whose last commit failed, in the rail's danger tone. It never clears on viewing: a failing
  branch clears when a later commit passes. `startCiAttention` polls from activation, so the badge is live while the board is closed.
- "Fix with agent" asks the daemon to start a fix conversation. Its id is derived from the run, so the board pairs
  runs with their fixes without a store of its own (`src/fixes/ciFixes.ts`).

## Key files

- [src/extension.ts](src/extension.ts) — registers the rail view: when it shows, its badge and its warm-up query.
- [src/PipelinesView.vue](src/PipelinesView.vue) — the board: repository picker, failing main lines, run rows.
- [src/ciStreaks.ts](src/ciStreaks.ts) — when a branch counts as failing, the rule behind the badge.
- [src/fixes/mainFailures.ts](src/fixes/mainFailures.ts) — a failing main line and its one fix agent, joined by the fixer's own id.
- [src/graph/pipelineDag.ts](src/graph/pipelineDag.ts) — a run's flat job list turned into layers.

## Commands

```sh
pnpm --filter @intentic/ext-pipelines test
```
