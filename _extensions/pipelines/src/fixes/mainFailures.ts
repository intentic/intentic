import {
    type AgentSummary,
    type CiMainFailure,
    type FixStance,
    fixStance,
    isPipelineInFlight,
    latestFixAttempt,
    type MainFailureHandBack,
    type PipelineRun,
} from "@intentic/sandbox-contract";

// A MAIN-LINE BRANCH WHOSE CI FAILS, AND ITS ONE FIX AGENT, as the board draws it: one incident block at the head of its
// repository's runs, holding the runs it is about (coveredRuns). The daemon keeps the failure (`ci.runs` `failures`,
// ci/main-fixer.ts): since the first job failed, the jobs failing now, the one conversation every later failure on the
// branch goes to, and the latest decision about it. The agent's live state is the
// fleet's, read by the fixer's own id: it was started on the first failed run, so a later run's derived id
// (ciFixConversationId) names somebody else, and joining by run would lose it the moment main failed again.

export type MainFailureState =
    // A fix agent has it: the daemon started one, and every failure on the branch goes to it until a run passes.
    | `fixing`
    // Its turns are spent, or it finished without changing anything: the failure is the owner's now.
    | `waits`
    // Repairs are switched off, so nobody was sent: the owner's from the start.
    | `reported`
    // Nobody is on it yet: the sandbox has not decided, which lasts until it has read the first failed job.
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
}

// Only the two waits ask for the reader; anything else (a fix-up, or no decision yet) is somebody else's to act on.
export const mainFailureState = (failure: CiMainFailure): MainFailureState => {
    const kind = failure.decision?.kind;
    if (kind === `spent`) {
        return `waits`;
    }
    if (kind === `reported`) {
        return `reported`;
    }
    return failure.fixer !== undefined || kind === `fix-up` ? `fixing` : `unassigned`;
};

// Every failing main line, the longest-failing first: the breakage that has waited longest is the one a reader is owed
// first.
export const mainFailuresOf = (
    failures: readonly CiMainFailure[] | undefined,
    agents: readonly AgentSummary[],
    runs: readonly PipelineRun[],
): MainFailureView[] =>
    (failures ?? [])
        .map((failure): MainFailureView => {
            const fixer = failure.fixer === undefined ? undefined : latestFixAttempt(failure.fixer, agents)?.agent;
            return {
                failure,
                state: mainFailureState(failure),
                fixer,
                stance: fixer === undefined ? undefined : fixStance(fixer),
                run: runs.find((run) => run.repo === failure.repo && run.runId === failure.runId),
            };
        })
        .toSorted((left, right) => left.failure.since - right.failure.since);

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

// The runs a failing main line speaks for, which the board draws inside its block, joined to its header by a drawn
// lane: the branch's failures that nothing has passed since (a superseded one is history, and stays with the other
// runs), and the runs on it still going, since a push after the fix is how it gets measured. In the board's own order.
export const coveredRuns = (
    failure: Pick<CiMainFailure, "repo" | "branch">,
    runs: readonly PipelineRun[],
    superseded: ReadonlyMap<PipelineRun, PipelineRun>,
): PipelineRun[] =>
    runs.filter(
        (run) =>
            run.repo === failure.repo &&
            run.branch === failure.branch &&
            ((run.status === `failed` && !superseded.has(run)) || isPipelineInFlight(run.status)),
    );

// What the block's one sentence says: the state the failure is in, in the reader's terms, and the move it asks for. While
// the agent has it, its live stance decides, since "an agent is on it" is the wrong sentence once the fix is written or
// landed. A landed fix is measured by the next push (main-fixer.ts: the owner commits and pushes it), so a run that
// started after it landed is that measurement under way.
export type MainFailureStory = `working` | `needsYou` | `ready` | `landed` | `proving` | `waiting` | `ended` | Exclude<MainFailureState, `fixing`>;

export const storyOf = (view: Pick<MainFailureView, "state" | "stance" | "fixer">, covered: readonly PipelineRun[]): MainFailureStory => {
    if (view.state !== `fixing`) {
        return view.state;
    }
    switch (view.stance?.kind) {
        case `needs-you`:
            return `needsYou`;
        case `ready`:
            return `ready`;
        case `landed`: {
            const landedAt = view.fixer?.updatedAt ?? Number.POSITIVE_INFINITY;
            return covered.some((run) => isPipelineInFlight(run.status) && run.createdAt > landedAt) ? `proving` : `landed`;
        }
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
