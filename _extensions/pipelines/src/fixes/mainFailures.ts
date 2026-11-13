import type { AgentSummary } from "@intentic/sandbox-contract/schemas/agents";
import {
    type CiMainFailure,
    type CiMainFailureWorkflow,
    type CiOwnerStep,
    type CiRepo,
    isPipelineInFlight,
    MAIN_FAILURE_STALE_MS,
    type MainFailureHandBack,
    type PipelineRun,
} from "@intentic/sandbox-contract/schemas/ci";
import { type FixStance, fixStance } from "@intentic/sandbox-contract/state/fix-stance";
import { latestFixAttempt } from "@intentic/sandbox-contract/ids/conversation-ids";
import { ownerStepOf } from "./ciFixes";

// A MAIN-LINE BRANCH WHOSE CI FAILS, AND ITS ONE FIX AGENT, as the board draws it: one incident block at the head of its
// repository's runs, holding the runs it is about (coveredRuns). The daemon keeps the failure (`ci.runs` `failures`,
// ci/main-fixer.ts): since the first job failed, the jobs failing now, the one conversation every later failure on the
// branch goes to, and the latest decision about it. The agent's live state is the
// fleet's, read by the fixer's own id: it was started on the first failed run, so a later run's derived id
// (ciFixConversationId) names somebody else, and joining by run would lose it the moment main failed again.

export type MainFailureState =
    // A fix agent has it: the daemon started one, and every failure on the branch goes to it until a run passes.
    | `fixing`
    // A run after the last fix landed already has failures, even if the run is still measuring.
    | `failed-again`
    // Its turns are spent, or it finished without changing anything: the failure is the owner's now.
    | `waits`
    // Repairs are switched off, so nobody was sent: the owner's from the start.
    | `reported`
    // Nobody is on it yet: the sandbox hands a run's failures over once the run has finished measuring (or has gone on
    // past its clock), so this lasts until the first failed run is done.
    | `unassigned`;

export interface MainFailureView {
    readonly failure: CiMainFailure;
    readonly state: MainFailureState;
    // The fixer's card on the fleet: its newest attempt, since starting over files the earlier one away. Absent when the
    // failure names nobody, or the fleet no longer carries the conversation it names.
    readonly fixer: AgentSummary | undefined;
    readonly stance: FixStance | undefined;
    // The newest failed run the failure names, while the board still lists it: what a Fix press from the banner acts on.
    readonly run: PipelineRun | undefined;
    // The step outside the repository the fix agent ended its latest turn on (owner-steps.ts), while that is its last word.
    readonly ownerStep?: string | undefined;
}

// A hand-back outranks the agent's stance; otherwise known failures after landing reopen its fix control.
export const mainFailureState = (failure: CiMainFailure, fixer?: AgentSummary, run?: PipelineRun): MainFailureState => {
    const kind = failure.decision?.kind;
    if (kind === `spent`) {
        return `waits`;
    }
    if (kind === `reported`) {
        return `reported`;
    }
    // `run` is the daemon's newest failing run, so its presence is evidence of failed jobs even before its final verdict.
    if (
        fixer !== undefined &&
        fixStance(fixer).kind === `landed` &&
        run !== undefined &&
        run.createdAt > fixer.updatedAt &&
        (run.status === `failed` || isPipelineInFlight(run.status))
    ) {
        return `failed-again`;
    }
    return failure.fixer !== undefined || kind === `fix-up` ? `fixing` : `unassigned`;
};

// When the failure began as the reader should be told it: its longest-failing workflow's own start, since each workflow
// keeps its own and the failure's `since` is when its first job ever failed. A failure that absorbed a month of other
// breakages said "since Oct 5" over a CI breakage of that morning. From a daemon that does not time workflows apart, the
// failure's own.
export const failingSince = (failure: Pick<CiMainFailure, "since" | "workflows">): number => {
    const starts = (failure.workflows ?? []).flatMap((workflow) => (workflow.since === undefined ? [] : [workflow.since]));
    return starts.length === 0 ? failure.since : Math.min(...starts);
};

// Every failing main line, the longest-failing first: the breakage that has waited longest is the one a reader is owed
// first.
export const mainFailuresOf = (
    failures: readonly CiMainFailure[] | undefined,
    agents: readonly AgentSummary[],
    runs: readonly PipelineRun[],
    steps: readonly CiOwnerStep[] = [],
): MainFailureView[] =>
    (failures ?? [])
        .map((failure): MainFailureView => {
            const fixer = failure.fixer === undefined ? undefined : latestFixAttempt(failure.fixer, agents)?.agent;
            const run = runs.find((candidate) => candidate.repo === failure.repo && candidate.branch === failure.branch && candidate.runId === failure.runId);
            return {
                failure,
                state: mainFailureState(failure, fixer, run),
                fixer,
                stance: fixer === undefined ? undefined : fixStance(fixer),
                run,
                ownerStep: ownerStepOf(fixer, steps),
            };
        })
        .toSorted((left, right) => failingSince(left.failure) - failingSince(right.failure));

// The keys the view's `busy` lock files the block's own presses under, beside the run rows' `host:project:runId`: a
// workflow's fresh start is addressed by its failing run, which the board often no longer lists, and letting go of a
// workflow (or of the whole failure, with none named) by the branch it fails on.
export const dispatchKey = (run: Pick<PipelineRun, "repo" | "runId">): string => `dispatch:${run.repo}:${run.runId}`;
export const forgetKey = (failure: Pick<CiMainFailure, "repo" | "branch">, workflow: string | undefined): string =>
    `forget:${failure.repo}:${failure.branch}:${workflow ?? ``}`;

// Whether a failure waits for the reader, for the banner and the rail to say so the same way.
export const waitsForYou = (view: Pick<MainFailureView, "state">): boolean => view.state === `waits` || view.state === `reported`;

// Whether the banner offers a Fix press of its own: on the newest failed run it names, once nobody is working on it.
export const offersFix = (view: Pick<MainFailureView, "state" | "run">): boolean => view.run !== undefined && view.state !== `fixing`;

// Whether the banner speaks for its branch's fix, so the run rows under it offer none of their own: no Fix, no Continue,
// no Start over, no pointer to the agent. A press on any of main's failed runs goes to the same one fix agent
// (ci.routes.ts, streakFixerFor), so a second button on a row would only be the banner's press again, one line lower and
// worded as if it started somebody new. True while an agent works on it, or while the banner holds the press; only a
// banner with neither (its run has left the board, and nobody is on it) leaves the rows theirs.
export const leadsRows = (view: Pick<MainFailureView, "state" | "run">): boolean => view.state === `fixing` || offersFix(view);

// The workflow a board run belongs to, as the daemon names it: GitHub's workflow name, or `ci` where a commit runs one
// pipeline (GitLab) and the run names none (main-streak.ts, workflowOf).
const ONE_PIPELINE = `ci`;
export const workflowOfRun = (run: Pick<PipelineRun, "workflow">): string =>
    run.workflow === undefined || run.workflow === `` ? ONE_PIPELINE : run.workflow;

// The board's runs of one failing workflow on the failure's branch that came after its failing run, newest first. Run
// ids only grow on both forges, so "after" needs no clock, and holds for a failing run the board no longer lists.
const runsAfter = (
    failure: Pick<CiMainFailure, "repo" | "branch">,
    workflow: Pick<CiMainFailureWorkflow, "name" | "runId">,
    runs: readonly PipelineRun[],
): PipelineRun[] =>
    runs
        .filter(
            (run) =>
                run.repo === failure.repo && run.branch === failure.branch && workflowOfRun(run) === workflow.name && run.runId > workflow.runId,
        )
        .toSorted((left, right) => right.runId - left.runId);

// The newest run of a failing workflow when it was cancelled after the run that failed it: the run that would have
// measured the fix, and the reason nothing did. GitHub's own page shows it as the workflow's state, so the block draws
// it too, or the two disagree about what main is doing.
const cancelledAfter = (
    failure: Pick<CiMainFailure, "repo" | "branch">,
    workflow: Pick<CiMainFailureWorkflow, "name" | "runId">,
    runs: readonly PipelineRun[],
): PipelineRun | undefined => {
    const [newest] = runsAfter(failure, workflow, runs);
    return newest?.status === `canceled` ? newest : undefined;
};

// The runs the daemon names as failing now: each failing workflow's newest failed run. Its word outranks the board's
// "superseded", which is per commit: a later commit whose CI passed says nothing of a nightly that does not run on a push,
// and the board would otherwise file the nightly's failure away as history while the banner says main still fails.
const namedRuns = (failure: Pick<CiMainFailure, "workflows">): ReadonlySet<number> =>
    new Set((failure.workflows ?? []).map((workflow) => workflow.runId));

// The runs a failing main line speaks for, which the board draws inside its block, joined to its header by a drawn
// lane: the branch's failures that nothing has passed since (a superseded one is history, and stays with the other
// runs) and the ones the daemon names failing whatever passed after them, the runs on it still going, since a push
// after the fix is how it gets measured, and each failing workflow's newest run where it was cancelled after the
// failure, which is why nothing measured it. In the board's own order.
export const coveredRuns = (
    failure: Pick<CiMainFailure, "repo" | "branch" | "workflows">,
    runs: readonly PipelineRun[],
    superseded: ReadonlyMap<PipelineRun, PipelineRun>,
): PipelineRun[] => {
    const named = namedRuns(failure);
    const cancelled = new Set((failure.workflows ?? []).flatMap((workflow) => cancelledAfter(failure, workflow, runs) ?? []));
    return runs.filter(
        (run) =>
            run.repo === failure.repo &&
            run.branch === failure.branch &&
            ((run.status === `failed` && (named.has(run.runId) || !superseded.has(run))) || isPipelineInFlight(run.status) || cancelled.has(run)),
    );
};

// How long a failing workflow goes without failing again, or anything else running it, before the banner says nothing
// is measuring it and offers to stop tracking it: past a nightly's day and a busy branch's pushes, and well short of
// the daemon dropping it by itself (MAIN_FAILURE_STALE_MS).
export const QUIET_AFTER_MS = 3 * 24 * 60 * 60_000;

// What stands between one failing workflow and the branch passing again, and so what the reader can do about it.
// `measuring`: a run of it is going now, so wait. `cancelled`: its newest run, after the failure, was cancelled (a
// person, a newer push's concurrency group, a runner that never came), so nothing measured it, and a re-run does.
// `scheduled`: a push never runs it, only its schedule or a manual start, so Run now measures it today. `quiet`: it has
// not failed for days and nothing ran it since, so nothing is measuring it; the daemon drops it at `dropsAt`, and
// Stop tracking does it now. `next`: its newest run is the failing one, and the next push or the fix agent's work is
// what measures it, which the story already says.
export type WorkflowBlocker =
    | { readonly kind: `measuring`; readonly run: PipelineRun }
    | { readonly kind: `cancelled`; readonly run: PipelineRun }
    | { readonly kind: `scheduled` }
    | { readonly kind: `quiet`; readonly failedAt: number; readonly dropsAt: number; readonly scheduled: boolean }
    | { readonly kind: `next` };

// One failing workflow's blocker, read off the daemon's fields first and the board's runs second: the failing run is
// often older than every run listed (a nightly), and the daemon's trigger and time then say what the board cannot.
export const blockerOf = (
    failure: Pick<CiMainFailure, "repo" | "branch">,
    workflow: CiMainFailureWorkflow,
    runs: readonly PipelineRun[],
    now: number,
): WorkflowBlocker => {
    const failing = runs.find((run) => run.repo === failure.repo && run.runId === workflow.runId);
    // A re-run keeps its run's id, so the failing run itself going again is a measurement too.
    const going = [...runsAfter(failure, workflow, runs), ...(failing === undefined ? [] : [failing])].find((run) => isPipelineInFlight(run.status));
    if (going !== undefined) {
        return { kind: `measuring`, run: going };
    }
    const cancelled = cancelledAfter(failure, workflow, runs);
    if (cancelled !== undefined) {
        return { kind: `cancelled`, run: cancelled };
    }
    const scheduled = (workflow.trigger ?? failing?.trigger) === `schedule`;
    const failedAt = workflow.failedAt ?? failing?.createdAt;
    if (failedAt !== undefined && now - failedAt > QUIET_AFTER_MS) {
        return { kind: `quiet`, failedAt, dropsAt: failedAt + MAIN_FAILURE_STALE_MS, scheduled };
    }
    return scheduled ? { kind: `scheduled` } : { kind: `next` };
};

// Whether nothing on its way will measure the workflow: no run of it going, and its next one is not a push's to start.
export const stalls = (blocker: WorkflowBlocker): boolean => blocker.kind !== `measuring` && blocker.kind !== `next`;

// One workflow failing on the branch, as the banner names it: which, its jobs, and the way to its failing run, whether
// the board lists that run or not, with what blocks it from passing. A scheduled workflow's run is often older than every
// run listed, which is how a board of green rows sits under "main is failing".
export interface FailingWorkflow {
    readonly name: string;
    // Spelled only where a push starts several pipelines (GitHub); a GitLab commit's one pipeline needs no name.
    readonly named: boolean;
    readonly runId: number;
    readonly jobs: readonly string[];
    // Those of its jobs that ran out of time, which the banner says apart: the forge calls them cancelled.
    readonly timedOut: readonly string[];
    // When it began failing, where the daemon keeps it per workflow.
    readonly since: number | undefined;
    // The run's page: the listed run's own link, else built from the repository's.
    readonly url: string | undefined;
    // Whether the board lists the run, so the reader is told when the one failing is not among the rows.
    readonly listed: boolean;
    readonly blocker: WorkflowBlocker;
}

// A run's page when the board does not list it, on each forge's own path.
const runPage = (repo: Pick<CiRepo, "host" | "url">, runId: number): string =>
    repo.host === `github` ? `${repo.url}/actions/runs/${runId}` : `${repo.url}/-/pipelines/${runId}`;

// Each workflow failing on the branch, in the order they began failing. Empty from a daemon that does not say, which
// leaves the banner its flat list of jobs.
export const failingWorkflowsOf = (
    failure: Pick<CiMainFailure, "repo" | "branch" | "workflows">,
    runs: readonly PipelineRun[],
    repo: Pick<CiRepo, "host" | "url"> | undefined,
    now: number = Date.now(),
): FailingWorkflow[] =>
    (failure.workflows ?? []).map((workflow) => {
        const run = runs.find((candidate) => candidate.repo === failure.repo && candidate.runId === workflow.runId);
        return {
            name: workflow.name,
            named: repo?.host !== `gitlab`,
            runId: workflow.runId,
            jobs: workflow.jobs,
            timedOut: workflow.timedOut ?? [],
            since: workflow.since,
            url: run?.url ?? (repo === undefined ? undefined : runPage(repo, workflow.runId)),
            listed: run !== undefined,
            blocker: blockerOf(failure, workflow, runs, now),
        };
    });

// What the block's one sentence says: the state the failure is in, in the reader's terms, and the move it asks for. While
// the agent has it, its live stance decides, since "an agent is on it" is the wrong sentence once the fix is written or
// landed. A landed fix is measured by the next push (main-fixer.ts: the owner commits and pushes it), so a run that
// started after it landed is that measurement under way. A run on the branch that started after it landed, with none
// of the failing workflows going now, means the push happened and nothing on its way will measure what still fails:
// those workflows were cancelled, run on a schedule, or were not run by that push. That is `stalled`, and its way
// forward is each workflow's own line (blockerOf), never "commit and push it" again. Only a pass of one of the failing
// workflows says anything about them: Scorecard or CodeQL passing after the push once made the banner say "newer runs
// on main pass" while CI itself had been cancelled.
export type MainFailureStory =
    | `working`
    | `needsYou`
    | `ready`
    | `landed`
    | `proving`
    | `collecting`
    | `stalled`
    | `waiting`
    | `ended`
    // The fix agent says no commit fixes it: a step outside the repository is the reader's (owner-steps.ts).
    | `outside`
    | Exclude<MainFailureState, `fixing`>;

// A landed fix's story: being measured, measured by nothing on its way (`stalled`), or still to be pushed.
const landedStory = (
    failure: Pick<CiMainFailure, "repo" | "branch" | "workflows">,
    landedAt: number,
    covered: readonly PipelineRun[],
    runs: readonly PipelineRun[],
    now: number,
): MainFailureStory => {
    if (covered.some((run) => isPipelineInFlight(run.status) && run.createdAt > landedAt)) {
        return `proving`;
    }
    const onBranch = runs.filter((run) => run.repo === failure.repo && run.branch === failure.branch && run.createdAt > landedAt);
    const workflows = failure.workflows ?? [];
    if (workflows.length === 0) {
        // A daemon that does not tell workflows apart: any pass after the land is the push's word.
        return onBranch.some((run) => run.status === `success`) ? `stalled` : `landed`;
    }
    const waiting = workflows.some((workflow) => !stalls(blockerOf(failure, workflow, runs, now)));
    return onBranch.length > 0 && !waiting ? `stalled` : `landed`;
};

export const storyOf = (
    view: Pick<MainFailureView, "state" | "stance" | "fixer" | "ownerStep"> & {
        readonly failure: Pick<CiMainFailure, "repo" | "branch" | "workflows">;
        readonly run?: PipelineRun | undefined;
    },
    covered: readonly PipelineRun[],
    runs: readonly PipelineRun[] = [],
    now: number = Date.now(),
): MainFailureStory => {
    if (view.state === `failed-again` && view.run !== undefined && isPipelineInFlight(view.run.status)) {
        return `collecting`;
    }
    if (view.state !== `fixing`) {
        return view.state;
    }
    // Its step outranks what it holds: a docs change landed beside a dashboard step is not the fix.
    if (view.ownerStep !== undefined) {
        return `outside`;
    }
    switch (view.stance?.kind) {
        case `needs-you`:
            return `needsYou`;
        case `ready`:
            return `ready`;
        case `landed`:
            return landedStory(view.failure, view.fixer?.updatedAt ?? Number.POSITIVE_INFINITY, covered, runs, now);
        case `waiting`:
            return `waiting`;
        case `ended`:
            return `ended`;
        default:
            return `working`;
    }
};

// Why the fix agent handed it back, as the closed set the banner words itself. Undefined when it was not handed back, or
// by a daemon from before the reason was recorded, which the banner says generically rather than by quoting its
// sentence: that sentence could carry a whole turn's error.
export const handBackOf = (view: Pick<MainFailureView, "failure" | "state">): MainFailureHandBack | undefined =>
    view.state === `waits` ? view.failure.decision?.reason : undefined;

// How many job names the banner spells before it folds the rest into "+N more". The run row below draws every job in
// its graph; the banner only has to say which ones, so a failure of six jobs does not become a wall of chips. One more
// than the room never folds: "+1 more" costs the width the name would.
const JOBS_SPELLED = 3;

export const jobsAtAGlance = (jobs: readonly string[]): { readonly shown: readonly string[]; readonly folded: readonly string[] } =>
    jobs.length <= JOBS_SPELLED + 1 ? { shown: jobs, folded: [] } : { shown: jobs.slice(0, JOBS_SPELLED), folded: jobs.slice(JOBS_SPELLED) };
