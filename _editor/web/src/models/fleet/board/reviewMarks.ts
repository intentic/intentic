import { sandboxRef } from "@intentic/extension-api";

// WHICH FILES OF AN AGENT'S WORK THE READER HAS MARKED REVIEWED: written by the review pass (useAgentChanges), read by
// the board card too, which leads with Review & land until the pass is done. Here rather than in either feature, which
// both read it.

// Per-agent set of files already viewed; module-level so navigating away and back keeps it, but lost on reload, and on
// a switch, since agent ids are minted per daemon and the next sandbox's same id is another agent.
export const viewedByAgent = sandboxRef<ReadonlyMap<string, ReadonlySet<string>>>(() => new Map());
export const NO_FILES_VIEWED: ReadonlySet<string> = new Set();
// Takes a set of keys, not one: a per-key setter would copy the set and write N times for one heading toggle.
export const setAgentViewed = (agentId: string, keys: readonly string[], on: boolean): void => {
    const next = new Set(viewedByAgent.value.get(agentId) ?? NO_FILES_VIEWED);
    for (const key of keys) {
        if (on) {
            next.add(key);
        } else {
            next.delete(key);
        }
    }
    const byAgent = new Map(viewedByAgent.value);
    byAgent.set(agentId, next);
    viewedByAgent.value = byAgent;
};
// Whether the reader has ticked as many files of this agent's work as it changed, read by a board card that holds the
// count but not the rows: its primary press is Review & land until then, Land now once the pass is done (AgentCard).
export const reviewedAll = (agentId: string, files: number): boolean => files > 0 && (viewedByAgent.value.get(agentId)?.size ?? 0) >= files;
