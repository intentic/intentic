# @intentic/ext-pipelines

CI as it actually went: runs, their jobs, and which failures are a streak rather than a blip.

## Responsibilities

- List pipeline runs for the repos that map to CI projects, with their jobs.
- Draw a run's job graph, so a failure's blast radius is visible rather than inferred, and draw it WITHOUT
  being asked for the runs that are still going on the code as it stands.
- Say whether a branch is red RIGHT NOW, on its last commit rather than on its last run, and keep saying it
  until a commit passes.
- Lead with the repository that needs a person, and keep the quiet ones out of the way without losing them.
- Put an agent on a failure, and then say what became of it: whether it is working, waiting on you, holding a
  fix nobody has landed, or over.

## Key files

- [src/usePipelines.ts](src/usePipelines.ts): the run list, from the connected provider.
- [src/repoStandings.ts](src/repoStandings.ts): how loudly each repository is asking, which is the board's order.
- [src/PipelinesView.vue](src/PipelinesView.vue): the board, and the options it hands the kit's `<Picker>` for the
  top bar's scope: all repositories, or one.
- [src/PipelinesTally.vue](src/PipelinesTally.vue): the orientation line, counts plus pass rate, in the one shape
  the title row, the narrow fallback and the loading state all draw.
- [src/pipelineDag.ts](src/pipelineDag.ts): jobs and their dependencies as a drawable graph, and the grouping of
  identically-wired jobs into one card.
- [src/PipelineDagGraph.vue](src/PipelineDagGraph.vue): that graph on a canvas, with the hover that traces one
  job's line through the run.
- [src/ciStreaks.ts](src/ciStreaks.ts), the rule the badge rests on: a branch's head COMMIT, red if any of its
  runs failed.
- [src/failureHistory.ts](src/failureHistory.ts): what has failed before, so a repeat reads as one.
- [src/statusVisual.ts](src/statusVisual.ts): one mapping from status to appearance.
- [src/useCiFixes.ts](src/useCiFixes.ts): the fix agents, read off the fleet roster, quickly while one is moving
  and at the board's own pace otherwise.
- [src/ciFixes.ts](src/ciFixes.ts): which failure each of them belongs to, and which branch already has one.
- [src/fixStance.ts](src/fixStance.ts): what an agent's state says on a red row, in the fleet's own words.

## How it fits

Capability-driven, not repo-driven: the tile surfaces when a github or gitlab connector is on, detected purely
from the public capability facts. Which repos actually map to CI projects is the daemon's answer, rendered
inside the view rather than gating the tile.

## Conventions & gotchas

- QUEUED IS ITS OWN STATE, not a flavour of running. The contract's `PipelineStatus` used to collapse every
  non-terminal vendor word onto `running`, on the reasoning that a board only needs "still moving" against the
  three ways a run stops. What that produced was a board spinning over work nothing was doing: a nightly whose
  self-hosted jobs are waiting on offline runners read as jobs in progress, with a duration ticking up, for as
  long as the runners stayed down. Queued draws as a static clock in a dashed ring, is counted apart in the tally
  and in a repository's standing, keeps Cancel on offer, and carries no duration. The two are still one class
  wherever the question is "has this said anything yet" — `isPipelineInFlight`, in the contract because the
  daemon splits on it too.
- ACTIONS REPORTS A `started_at` FOR A JOB THAT NEVER STARTED, set to the moment the run was queued, so the
  daemon drops it (`providers.ts`). Everything here reads a present `startedAt` as "this began": it is what the
  wave layering files jobs by and what a duration is measured from, so a job waiting an hour for a runner would
  otherwise arrive claiming an hour of work and be drawn among the jobs that did it.
- A branch is judged on its LAST COMMIT, not its last run. One push fires every workflow the repo has, they
  start in the same second, and reading the branch off whichever run carried the newest timestamp let a green
  sibling hide a red one: the rail's badge blinked out while main was broken. Any failure among a commit's runs
  makes that commit red.
- The badge is a STATE, not a piece of news: it stays lit for as long as a branch's last commit is red and
  clears when a later commit passes. It used to clear when you opened the board, which meant the one surface
  that could say "main is still broken" went dark after a glance. What keeps the number from becoming noise is
  its shape, one per broken branch however many runs or commits deep the breakage is, not a read marker.
- Which repository the board shows is a picker in the TOP BAR, the same control Documentation picks its
  repository with, and "All repositories" is where it opens: the first question a CI board answers is "is
  anything red anywhere". It was a 16rem rail of counts down the left, and the reason it is not any more is what
  this board's body actually is: a run's job graph, the widest thing in the app. Permanent chrome for a choice
  made once a session was costing the diagram the width it needed to be read. Each row of the picker still
  carries its repository's whole standing (`standingNote`, failing branches first, so the clause worth reading is
  the one that survives truncation), the sections below are ordered worst-first whatever is picked, and the
  sidebar badge still says that a branch is red wherever you are.
- WHAT THE NEWEST COMMIT ON A BRANCH HAS TO SAY THAT IS NOT "FINE" ARRIVES EXPANDED, so the diagram this board
  exists to draw is on screen before anyone clicks (`arrivesOpen`). Two halves, and they are one event either
  side of its ending: the runs that have not finished there (`inFlightOnHead`, where the graph is the answer
  arriving — a run still waiting for a runner counts, and is the case the diagram pays for most), and
  the failures it left open (`openFailures`, where the same graph is which job broke, and is the evidence the
  "Fix with agent" button beside it acts on). Opening a pipeline while it ran and shutting it the instant it went
  red would close at the one moment there was something to read, and would leave everyone who arrived after the
  run finished clicking to find out what a red row is red about. A union rather than a precedence: a commit whose
  first workflow failed while its second is still going is two rows worth opening.
- THE HEAD-COMMIT SHAPE IS WHAT KEEPS THAT READABLE. A re-run somebody left going on last week's code stays shut,
  a failure behind a newer one stays shut, a failure a later commit closed stays shut, and a breakage six commits
  deep opens one row on that branch rather than six, the same shape that keeps the fix demands to one per
  breakage. The two halves read "head" differently on purpose: off every run for the live half, because a fresh
  push has nothing but running pipelines and that is exactly when it has to fire, and off the runs with a verdict
  for the failed half, so a push that is still building shows its live graph beside the failure the commit before
  it left open, which is the branch's most recent word until this one has anything to say.
- It is a DEFAULT, not a binding, seeded once when the row is created: a row the reader closed stays closed, going
  red later does not re-open what they shut, and a run that finishes under them keeps its graph rather than
  collapsing at the moment it says whether it passed.
- The status tally rides the TITLE ROW rather than a line of its own above the list, because the ~40px it was
  costing is the scarcest thing on a page whose body is a job graph. It falls back to its own line under 44rem
  of board (`TALLY_AT_REM`), measured off the body with a ResizeObserver rather than off the window: this view
  renders into a pane the reader can halve with the chat panel. In the header it takes a zero flex basis, so the
  width it needs comes out of the row's slack and never out of the `<h1>`.
- A FIX CONVERSATION IS NAMED AFTER THE RUN IT FIXES (`ci-fix-<repo>-<runId>`, minted in the contract's
  `conversation-ids.ts`), and that one decision is what makes the row able to report at all. Nothing records
  which agent was started for which failure; the fleet roster is the record, and a roster is keyed by id, so an
  id nobody can re-compute is a record nobody can read. It used to carry a timestamp and a counter, so the board
  could only ever offer "Fix with agent", to every browser, forever, including while an agent was parked on a
  question nobody would see. Deriving it also makes one failure one conversation: a second press continues that
  agent on its branch instead of racing a second one beside it.
- ONE SLOT ON THE ROW FOR THE AGENT, whichever half of its life it is in: the button becomes a state chip
  (`fixStance.ts`), and only an ENDED fix turns back into a press, labelled "Try again". The words are the fleet
  board's own, a card one click away must not describe the same agent differently.
- THE CHIP IS THE REPORT while a fix is still in play: the state, its age, the spend and the diff used to be
  repeated as a line of facts above the job graph, so every open row paid a diagram's worth of height to say a
  second time what the header had already said once. Now the chip carries the word and the age always, the money
  and the diff at `@3xl` of ROW (this board renders into a pane the reader can halve with the chat panel), and
  the model's name, the file count and the exact phrasing of the age in its tooltip, where width is free. Once
  landed, the label alone — the work is in the workspace and Re-run is the next move. Same rule one turn on for
  the branch's agent: a row with none of its own gets a neutral chip that opens it, rather than a sentence under
  the header.
- An ending outranks a diff. An agent that crashed after writing two files has one, and reading that as a fix
  ready to land is the board promising something the turn never finished; the files earn a sentence in the
  hint, not the verdict. Same order the fleet's own lane machine reads them in.
- A fix belongs to a RUN, a breakage belongs to a BRANCH, so a row with no agent of its own is told when
  another run of its branch has one: the button demotes and says which run to open, and the chip beside it is
  the press that opens it. Without it the newest red row cheerfully offers a second agent for work already in
  flight one row below it.
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
