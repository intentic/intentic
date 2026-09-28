# pipelines

The Pipelines rail view: CI runs from the workspace repositories' GitHub and GitLab remotes on one board, main's red with the one fix agent on it, and what the pre-push check let through, with rerun, cancel, fix and hand-over actions.

```mermaid
flowchart LR
    vendor["GitHub · GitLab CI"] -->|"webhooks · backfill"| daemon["Daemon ci · push-checks routes"]
    hook["pre-push hook<br/>report in the git dir"] -->|"filed once pushed"| daemon
    daemon --> ext(["pipelines<br/>browser"])
    ext -->|"rerun · cancel · jobs · fix"| daemon
    ext -->|"dismiss · recheck · hand over"| daemon
    daemon -->|"fix · hand-over"| agent["Fix conversation"]
    ext --> badge["Rail badge<br/>red branches · left at push"]
```

- Runs in the browser, compiled into the editor app as a builtin. It holds no CI or push state: runs, jobs and main's
  reds come from the daemon's `ci` procedures, which keep them fresh from vendor webhooks and backfill when stale, and
  what pushes left comes from `workspace.pushChecks`, which the daemon's `pushes` push keeps current.
- The tile appears when a GitHub or GitLab `cli` capability is connected, or once the hook has measured a push: what a
  push left exists without any CI. The board shows the open project's repositories, ranks them by how loudly they ask
  (`src/repoStandings.ts`) and draws each run's jobs as a layered graph (`src/graph/pipelineDag.ts`).
- A red main-line branch says so once at the head of its repository's runs (`src/fixes/MainRedCallout.vue`): since when, the
  jobs failing now, and the one fix agent the daemon put on it at the first failed job, which every later failure on the
  branch goes to until a run passes. The agent is joined by the id the red names (`fixer`), never by a later run's
  derived id, and the red turns to "Waits for you" once the daemon hands it back: its turns spent, it finished without
  changing anything, or repairs are off (`src/fixes/mainReds.ts`).
- Left at push sits above the runs and never waits on their load (`src/push/LeftAtPush.vue`). Per project, what its push red
  still owes, the push that brought it, and the pushes the hook measured, each marked clean, handled, refused or how
  much it left (`src/push/pushChecks.ts`). The owner's hands: measure again, dismiss (with Undo), and hand to an agent, which
  continues the same attempt while the red stands (the contract's `pushFixBase`). Nothing is sent to an agent unless the
  owner presses.
- The badge counts branches whose last commit is red, in the rail's danger tone. With nothing red it counts what pushes
  left, in the warning tone; with both, the red is the count and the tooltip names both. Neither clears on viewing: a red
  clears when a later commit passes, a finding when a later measurement stops printing it or the owner dismisses it.
  `startCiAttention` polls both from activation, so the badge is live while the board is closed.
- "Fix with agent" asks the daemon to start a fix conversation. Its id is derived from the run, so the board pairs
  runs with their fixes without a store of its own (`src/fixes/ciFixes.ts`).

## Key files

- [src/extension.ts](src/extension.ts) — registers the rail view: when it shows, its badge and its warm-up queries.
- [src/PipelinesView.vue](src/PipelinesView.vue) — the board: repository picker, Left at push, main's reds, run rows.
- [src/ciStreaks.ts](src/ciStreaks.ts) — when a branch counts as red, the rule behind the badge.
- [src/fixes/mainReds.ts](src/fixes/mainReds.ts) — main's red and its one fix agent, joined by the fixer's own id.
- [src/push/pushChecks.ts](src/push/pushChecks.ts) — what each project's pushes left, the push record and the hand-over's attempt.
- [src/graph/pipelineDag.ts](src/graph/pipelineDag.ts) — a run's flat job list turned into layers.

## Commands

```sh
pnpm --filter @intentic/ext-pipelines test
```
