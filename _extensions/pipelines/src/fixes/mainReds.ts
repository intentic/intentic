import { type AgentSummary, type CiMainRed, type FixStance, fixStance, latestFixAttempt, type PipelineRun } from "@intentic/sandbox-contract";

// MAIN'S CI RED AND ITS ONE FIX AGENT, as the board draws it above a repository's runs. The daemon keeps the red
// (`ci.runs` `reds`, ci/main-fixer.ts): since the first job failed, the jobs failing now, the one conversation every
// later failure on the branch goes to, and the latest decision about it. The agent's live state is the fleet's, read by
// the fixer's own id: it was started on the first failed run, so a later run's derived id (ciFixConversationId) names
// somebody else, and joining by run would lose it the moment main failed again.

export type MainRedState =
    // A fix agent has it: the daemon started one, and every failure on the branch goes to it until a run passes.
    | `fixing`
    // Its turns are spent, or it finished without changing anything: the red is the owner's now.
    | `waits`
    // Repairs are switched off, so nobody was sent: the owner's from the start.
    | `reported`
    // Nobody is on it yet: the sandbox has not decided, which lasts until it has read the first failed job.
    | `unassigned`;

export interface MainRedView {
    readonly red: CiMainRed;
    readonly state: MainRedState;
    // The fixer's card on the fleet: its newest attempt, since starting over files the earlier one away. Absent when the
    // red names nobody, or the fleet no longer carries the conversation it names.
    readonly fixer: AgentSummary | undefined;
    readonly stance: FixStance | undefined;
    // The newest red run the red names, while the board still lists it.
    readonly run: PipelineRun | undefined;
}

// Only the two waits ask for the reader; anything else (a fix-up, or no decision yet) is somebody else's to act on.
export const mainRedState = (red: CiMainRed): MainRedState => {
    const kind = red.decision?.kind;
    if (kind === `spent`) {
        return `waits`;
    }
    if (kind === `reported`) {
        return `reported`;
    }
    return red.fixer !== undefined || kind === `fix-up` ? `fixing` : `unassigned`;
};

// Every main-line red, the longest red first: the breakage that has waited longest is the one a reader is owed first.
export const mainRedsOf = (reds: readonly CiMainRed[] | undefined, agents: readonly AgentSummary[], runs: readonly PipelineRun[]): MainRedView[] =>
    (reds ?? [])
        .map((red): MainRedView => {
            const fixer = red.fixer === undefined ? undefined : latestFixAttempt(red.fixer, agents)?.agent;
            return {
                red,
                state: mainRedState(red),
                fixer,
                stance: fixer === undefined ? undefined : fixStance(fixer),
                run: runs.find((run) => run.repo === red.repo && run.runId === red.runId),
            };
        })
        .toSorted((left, right) => left.red.since - right.red.since);

// Whether a red waits for the reader, for the section and the rail to say so the same way.
export const waitsForYou = (view: Pick<MainRedView, "state">): boolean => view.state === `waits` || view.state === `reported`;
