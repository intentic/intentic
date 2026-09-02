import { type AgentSummary, ciFixConversationId, type PipelineRun } from "@intentic/sandbox-contract";
import { fixStance } from "./fixStance";

/* WHICH FAILURE EACH FIX AGENT BELONGS TO, joined the only way it can be: by RE-DERIVING the conversation's
 * name from the run (conversation-ids.ts). Nothing records the pairing anywhere, and nothing needs to, the
 * fleet roster is the record, and this is the key it is read with.
 *
 * KEYED BY THE RUN OBJECT, like every other cross-run reading on this board (ciStreaks' `openFailures` and
 * `supersededBy`): the rows render from the same array the query returned, so identity is a stable key and
 * costs no string building per row.
 *
 * THE SECOND DERIVATION IS THE ONE THAT MAKES THE BOARD HONEST. A fix belongs to a RUN, but a breakage belongs
 * to a BRANCH: an agent is working on the failure from run #41 while #43 fails on the same branch behind it,
 * and the row a reader is looking at, the newest one, would offer to start a second agent on work already in
 * progress. That is the exact waste this feature exists to prevent, so the branch's ongoing fix is carried to
 * its other rows as a hint (PipelineRunRow's `branchFix`).
 *
 * ONGOING ONLY, for that second reading. A fix that landed, or ended without producing anything, is not a
 * reason to withhold anything from another run of the same branch: the first is done and the second is over,
 * and starting a fresh agent is a decision the reader is entitled to make (fixStance's `ongoing`). */

export interface CiFix {
    readonly run: PipelineRun;
    readonly agent: AgentSummary;
}

export const branchKey = (run: PipelineRun): string => `${run.repo}\n${run.branch}`;

// The fix agents, filed under the runs they were started from. An agent whose run is not in the window (the
// board keeps the last few per project) simply has no row here, which is the same thing as not being shown.
export const fixesByRun = (runs: readonly PipelineRun[], agents: readonly AgentSummary[]): Map<PipelineRun, AgentSummary> => {
    const byId = new Map(agents.map((agent) => [agent.id, agent]));
    const fixes = new Map<PipelineRun, AgentSummary>();
    for (const run of runs) {
        const agent = byId.get(ciFixConversationId(run.repo, run.runId));
        if (agent !== undefined) {
            fixes.set(run, agent);
        }
    }
    return fixes;
};

// One ongoing fix per branch: the newest run's, since that is the one whose agent has seen the most of the
// breakage. Read by the rows that have no fix of their own.
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
