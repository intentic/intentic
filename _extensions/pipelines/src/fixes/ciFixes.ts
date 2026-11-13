import type { AgentSummary } from "@intentic/sandbox-contract/schemas/agents";
import { ciFixBase, latestFixAttempt } from "@intentic/sandbox-contract/ids/conversation-ids";
import { fixStance } from "@intentic/sandbox-contract/state/fix-stance";
import type { CiOwnerStep, PipelineRun } from "@intentic/sandbox-contract/schemas/ci";

// Joins a fix agent to its run by re-deriving the conversation id (conversation-ids.ts); nothing else records the
// pairing. Keyed by the run object, like other cross-run readings (ciStreaks). Also derives a branch's ongoing fix, so
// the newest row doesn't offer a second agent for work already in flight.

export interface CiFix {
    readonly run: PipelineRun;
    readonly agent: AgentSummary;
}

export const branchKey = (run: PipelineRun): string => `${run.repo}\n${run.branch}`;

// Fix agents filed under the runs they started from; an agent whose run has scrolled out of the board's window simply
// has no row here. A failure may have had several ATTEMPTS (conversation-ids.ts, fixAttemptId): the latest speaks for
// it, since every earlier one was set aside by the act of starting a later one.
export const fixesByRun = (runs: readonly PipelineRun[], agents: readonly AgentSummary[]): Map<PipelineRun, AgentSummary> => {
    const fixes = new Map<PipelineRun, AgentSummary>();
    const ids = agents.map((agent) => agent.id);
    for (const run of runs) {
        // Under the spelling the sandbox minted it with: a fix started before the ids were shortened keeps its own.
        const latest = latestFixAttempt(ciFixBase(run.repo, run.runId, ids), agents);
        if (latest !== undefined) {
            fixes.set(run, latest.agent);
        }
    }
    return fixes;
};

// One ongoing fix per branch, the newest run's (its agent has seen the most of the breakage); read by rows with no fix
// of their own.
export const branchFixes = (fixes: ReadonlyMap<PipelineRun, AgentSummary>): Map<string, CiFix> => {
    const byBranch = new Map<string, CiFix>();
    for (const [run, agent] of fixes) {
        if (!fixStance(agent).ongoing) {
            continue;
        }
        const key = branchKey(run);
        const held = byBranch.get(key);
        if (held === undefined || run.createdAt > held.run.createdAt) {
            byBranch.set(key, { run, agent });
        }
    }
    return byBranch;
};

// The step outside the repository a fix agent ended its latest turn on (the daemon's owner-steps.ts), while that turn is
// its last word: one running again, or waiting to, says nothing yet.
export const ownerStepOf = (agent: AgentSummary | undefined, steps: readonly CiOwnerStep[] | undefined): string | undefined => {
    if (agent === undefined) {
        return undefined;
    }
    const kind = fixStance(agent).kind;
    return kind === `working` || kind === `waiting` ? undefined : steps?.find((step) => step.conversationId === agent.id)?.step;
};
