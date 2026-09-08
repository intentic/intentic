import { type AgentSummary, ciFixConversationId, fixStance, latestFixAttempt, type PipelineRun } from "@intentic/sandbox-contract";

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
    for (const run of runs) {
        const latest = latestFixAttempt(ciFixConversationId(run.repo, run.runId), agents);
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
