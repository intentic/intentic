import type { AgentSummary } from "@intentic/sandbox-contract";

/* WHAT THE FLEET CARD SAYS ABOUT A LOOP — the live half of a loop, kept here and nowhere else.
 *
 * This module exists to be IMPORT-LIGHT. agents-registry.ts projects it onto every summary, and the registry is
 * upstream of essentially the whole daemon; if the projection lived in loop-runner.ts (which reaches Services,
 * git, and the turn generator) the registry would import the world and close a cycle on its way round. So the
 * pattern is the one agent/subagents.ts already set: a module singleton the registry reads by function call,
 * with nothing in its import list but a type.
 *
 * The one thing it adds over that precedent is a CHANGE NOTIFICATION, and it earns its place on the case
 * subagent counts don't have. A subagent's count only ever moves DURING a turn, and every turn frame broadcasts
 * the roster anyway, so the counts ride out for free. A loop's most important state change is the one that
 * happens BETWEEN turns — the last iteration's `finish` has already broadcast, and then the pump decides the
 * goal is met. Without a notification the card would sit on `running · iteration 12/12` until something
 * unrelated moved the fleet, which is precisely the moment a user is watching it.
 *
 * The map is not pruned when a loop ends. A finished loop is what the card is read for afterwards ("stalled
 * after 4"), it is one small entry per looped conversation, and `remove` takes it when the agent is discarded.
 */

export type LoopProjection = NonNullable<AgentSummary["loop"]>;

const live = new Map<string, LoopProjection>();
const listeners = new Set<() => void>();

// What the roster should say about this conversation; undefined for the overwhelming majority that never looped.
export const loopProjectionOf = (conversationId: string): LoopProjection | undefined => live.get(conversationId);

// Publish a loop's current state to every card. Called by the pump at each iteration boundary and once more
// when the loop ends.
export const setLoopProjection = (conversationId: string, projection: LoopProjection): void => {
    live.set(conversationId, projection);
    for (const listener of listeners) {
        listener();
    }
};

// Forget loops for agents that no longer exist — the registry's own `remove` (discard, archive purge) calls it
// with the same ids, so a conversation cannot leave a loop behind it.
export const forgetLoops = (conversationIds: readonly string[]): void => {
    for (const id of conversationIds) {
        live.delete(id);
    }
};

// Subscribe to loop-state changes; returns the unsubscribe. The registry is the only caller — it re-publishes
// the roster, which is the entire point of the notification.
export const onLoopChange = (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
};
