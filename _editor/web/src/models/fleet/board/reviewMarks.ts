import { sandboxRef } from "@intentic/extension-api";

// Which files of an agent's work the reader has marked reviewed in useAgentChanges, kept across review navigation.

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
