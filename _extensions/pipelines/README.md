# @intentic/ext-pipelines

CI as it actually went: runs, their jobs, and which failures are a streak rather than a blip.

## Responsibilities

- List pipeline runs for the repos that map to CI projects, with their jobs.
- Draw a run's job graph, so a failure's blast radius is visible rather than inferred.
- Tell a one-off failure from a streak, and badge only what deserves it.
- Lead with the repository that needs a person, and keep the quiet ones out of the way without losing them.

## Key files

- [src/usePipelines.ts](src/usePipelines.ts): the run list, from the connected provider.
- [src/repoStandings.ts](src/repoStandings.ts): how loudly each repository is asking, which is the board's order.
- [src/PipelinesView.vue](src/PipelinesView.vue): the board, and the rows it hands the kit's `<RepoRail>` for the
  scope column: all repositories, or one.
- [src/pipelineDag.ts](src/pipelineDag.ts): jobs and their dependencies as a drawable graph.
- [src/ciStreaks.ts](src/ciStreaks.ts), the distinction the badge rests on: a flake versus a broken main.
- [src/failureHistory.ts](src/failureHistory.ts): what has failed before, so a repeat reads as one.
- [src/statusVisual.ts](src/statusVisual.ts): one mapping from status to appearance.

## How it fits

Capability-driven, not repo-driven: the tile surfaces when a github or gitlab connector is on, detected purely
from the public capability facts. Which repos actually map to CI projects is the daemon's answer, rendered
inside the view rather than gating the tile.

## Conventions & gotchas

- A red run is not automatically news. `ciStreaks.ts` exists because badging every failure trains the eye to skip
  the badge, which costs more than the missed signal it was meant to catch.
- The rail NARROWS, it does not select. "All repositories" is where the board opens, because the first question a
  CI board answers is "is anything red anywhere": which is why this is a column with counts and not the
  repository dropdown Documentation uses, where you are always reading exactly one repository's pages.
- A repository with no runs is a rail row, not a card. A repository with a `hookWarning` is not: the warning is
  usually the reason it looks silent, so hiding it would hide the answer along with the question.
