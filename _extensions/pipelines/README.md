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
- [src/PipelinesView.vue](src/PipelinesView.vue): the board, and the options it hands the kit's `<Picker>` for the
  top bar's scope: all repositories, or one.
- [src/pipelineDag.ts](src/pipelineDag.ts): jobs and their dependencies as a drawable graph, and the grouping of
  identically-wired jobs into one card.
- [src/PipelineDagGraph.vue](src/PipelineDagGraph.vue): that graph on a canvas, with the hover that traces one
  job's line through the run.
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
- Which repository the board shows is a picker in the TOP BAR, the same control Documentation picks its
  repository with, and "All repositories" is where it opens: the first question a CI board answers is "is
  anything red anywhere". It was a 16rem rail of counts down the left, and the reason it is not any more is what
  this board's body actually is: a run's job graph, the widest thing in the app. Permanent chrome for a choice
  made once a session was costing the diagram the width it needed to be read. Each row of the picker still
  carries its repository's whole standing (`standingNote`, failing branches first, so the clause worth reading is
  the one that survives truncation), the sections below are ordered worst-first whatever is picked, and the
  sidebar badge still says when something went red while you were elsewhere.
- A repository with no runs is a picker row under "No runs yet", not a card in the body. A repository with a
  `hookWarning` is a card: the warning is usually the reason it looks silent, so hiding it would hide the answer
  along with the question.
- A card in the job graph is a GROUP of jobs, not a job. Jobs whose incoming and outgoing edges are identical are
  the same story told N times, and drawing one card each meant drawing every edge between two stages: a 12-leg
  test stage after a build is 24 arrows that say one thing. Grouped, it is one. Nothing is hidden by it, every
  job is still a row with its status, duration and failure streak, and the trace still counts jobs rather than
  cards, so "nine ran before" stays true.
- Column N holds the cards that could not have started before N others finished, and every column is packed from
  the same top. Both are corrections to what a layered graph library gives you by default: dagre ranks a node to
  make the total edge length short, which drifts a job that waits for nothing rightwards until it sits under the
  jobs it feeds and reads as waiting for them, and it spreads a column out to straighten the lines, which turned
  500px of content into a 944px picture on this workspace's own CI run. Depth and a packed column are what the
  vendors' own run graphs draw, and the arrows pay for it: they leave a card horizontally, turn once in the gap
  after their column, and arrive horizontally, so a fan-out reads as one bus rather than a dozen diagonals.
- Within a column, a card sits above another when its line continues sooner, and a card nothing waits on sinks to
  the bottom. That is the third correction, and the one people actually name when they say a diagram is messy:
  dagre optimises a crossing COUNT, and two orders with equally few crossings do not read equally. Its answer put
  `ci-base` last in its column while the job it feeds was at the top of the next, and left the run's dead ends
  (`migrations`, the e2e pair) in the middle of the spine, so following one branch meant zig-zagging across the
  whole picture. Ordered by continuation, `changes → ci-base → ci-desktop → desktop-check` is a straight run
  along the top, which is what GitHub's own view of the same workflow draws, column for column.
- A `uses: ./.github/workflows/release.yml` job is drawn as the chain inside that file, not as one card. A run
  reports one job per job of the called file (`release / plan`, `release / publish`, …) and tells you nothing
  about how they were wired, so the daemon fetches the called file alongside the run's own and reads its `needs`
  too: a called root hangs where the calling job hung, and a job that waited on the call waits on whatever
  FINISHES it. A call into ANOTHER repository is still a file nobody here can read, and its jobs stay siblings.
