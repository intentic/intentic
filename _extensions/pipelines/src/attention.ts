import type { AgentSummary } from "@intentic/sandbox-contract/schemas/agents";
import type { CiMainFailure, CiOwnerStep, PipelineRun } from "@intentic/sandbox-contract/schemas/ci";
import { fixStance } from "@intentic/sandbox-contract/state/fix-stance";
import { failureStreaks, openFailures, releaseFailures, supersededBy } from "./ciStreaks";
import { branchFixes, branchKey, fixesByRun, ownerStepOf } from "./fixes/ciFixes";
import { coveredRuns, type MainFailureStory, mainFailuresOf, storyOf } from "./fixes/mainFailures";

/* WHAT CI OWES THE READER, as the rail tile counts it. A failure is not by itself a reason to call somebody: one an agent
   is working, one waiting on its allowance, one a new run is measuring needs nobody, and a tile that stays red over them
   teaches the reader to stop looking (2026-11-12: a release failure two agents had worked kept the tile at "1" for
   hours, with nothing to do on the board but press Fix a third time). So each breakage is read for its next move, and
   only one that is the reader's counts. The rest ride the tile's running mark. */

export type OwedKind =
    // Failed, and nobody is on it: no fix agent, or auto-fix is off.
    | `unowned`
    // A fix agent was on it and stopped without a fix, or handed it back.
    | `handed-back`
    // The fix agent waits on the reader: a question, a plan, a permission, a setup.
    | `answer`
    // A fix is written and held on the agent's branch, waiting for review.
    | `review`
    // The fix is in the workspace and has not been measured: commit and push it (a release: release again).
    | `push`
    // The fix agent says no commit fixes it: a step outside the repository is the reader's (owner-steps.ts).
    | `outside`
    // A failing main's fix is pushed and nothing on its way measures it.
    | `stalled`;

export interface Owed {
    readonly repo: string;
    readonly branch: string;
    readonly kind: OwedKind;
    // A release's failure (a tag), whose landed fix is measured by the next release rather than by a push.
    readonly release: boolean;
    // The step outside the repository, in the agent's words, for `outside`.
    readonly step?: string | undefined;
}

export interface CiAttention {
    readonly owed: readonly Owed[];
    // Breakages that need nobody right now: a fix agent working or waiting, auto-fix about to start, a run measuring.
    readonly handled: number;
}

// A fix agent's next move, or `handled` when it has none for the reader.
const agentOwes = (agent: AgentSummary | undefined, steps: readonly CiOwnerStep[] | undefined): OwedKind | `handled` => {
    if (agent === undefined) {
        return `unowned`;
    }
    if (ownerStepOf(agent, steps) !== undefined) {
        return `outside`;
    }
    switch (fixStance(agent).kind) {
        case `working`:
        case `waiting`:
            return `handled`;
        case `needs-you`:
            return `answer`;
        case `ready`:
            return `review`;
        case `landed`:
            return `push`;
        default:
            return `handed-back`;
    }
};

// A failing main's story (mainFailures.ts) as the reader's move: the banner's sentence and the tile agree by construction.
const STORY_OWES = {
    working: `handled`,
    proving: `handled`,
    collecting: `handled`,
    waiting: `handled`,
    // Auto-fix hands the run over once it finishes: somebody is about to be on it.
    unassigned: `handled`,
    // Later failures go to the same agent by themselves while it has turns.
    "failed-again": `handled`,
    needsYou: `answer`,
    ready: `review`,
    landed: `push`,
    stalled: `stalled`,
    outside: `outside`,
    ended: `handed-back`,
    waits: `handed-back`,
    reported: `unowned`,
} as const satisfies Readonly<Record<MainFailureStory, OwedKind | `handled`>>;

// The agent that speaks for a breakage of failed runs: the most recently active of their own fix agents, else an ongoing
// fix started from an older run of the same branch (ciFixes.ts, branchFixes).
const agentFor = (
    failed: readonly PipelineRun[],
    fixes: ReadonlyMap<PipelineRun, AgentSummary>,
    branchFix: AgentSummary | undefined,
): AgentSummary | undefined =>
    failed
        .flatMap((run) => fixes.get(run) ?? [])
        .toSorted((a, b) => b.updatedAt - a.updatedAt)
        .at(0) ?? branchFix;

export const ciAttention = (
    runs: readonly PipelineRun[],
    failures: readonly CiMainFailure[] | undefined,
    agents: readonly AgentSummary[],
    steps: readonly CiOwnerStep[] | undefined,
): CiAttention => {
    const owed: Owed[] = [];
    let handled = 0;
    const tally = (repo: string, branch: string, kind: OwedKind | `handled`, release: boolean, step?: string): void => {
        if (kind === `handled`) {
            handled += 1;
        } else {
            owed.push({ repo, branch, kind, release, step });
        }
    };

    // A failing main line is the daemon's (main-fixer.ts): it tracks each workflow and keeps the one fix agent, so its
    // story is the word, and the branch's per-commit reading below stands aside for it.
    const superseded = supersededBy(runs);
    const mains = new Set<string>();
    for (const view of mainFailuresOf(failures, agents, runs, steps)) {
        mains.add(`${view.failure.repo}\n${view.failure.branch}`);
        const story = storyOf(view, coveredRuns(view.failure, runs, superseded), runs);
        tally(view.failure.repo, view.failure.branch, STORY_OWES[story], false, view.ownerStep);
    }

    const fixes = fixesByRun(runs, agents);
    const byBranch = branchFixes(fixes);
    const open = [...openFailures(runs)];
    for (const streak of failureStreaks(runs)) {
        const key = `${streak.repo}\n${streak.branch}`;
        if (mains.has(key)) {
            continue;
        }
        const failed = open.filter((run) => branchKey(run) === key);
        const agent = agentFor(failed, fixes, byBranch.get(key)?.agent);
        tally(streak.repo, streak.branch, agentOwes(agent, steps), false, ownerStepOf(agent, steps));
    }

    for (const run of releaseFailures(runs)) {
        const agent = fixes.get(run);
        tally(run.repo, run.branch, agentOwes(agent, steps), true, ownerStepOf(agent, steps));
    }
    return { owed, handled };
};

// The tile's tone: danger only for what is broken with nobody on it; a step or a stall the reader carries is a warning;
// a review, an answer or a push is ordinary actionable work.
export const owedTone = (owed: readonly Owed[]): `danger` | `warning` | `info` => {
    if (owed.some((item) => item.kind === `unowned` || item.kind === `handed-back`)) {
        return `danger`;
    }
    return owed.some((item) => item.kind === `outside` || item.kind === `stalled`) ? `warning` : `info`;
};
