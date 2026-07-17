import type { AgentSummary } from "@intentic/sandbox-contract";
import { computed, ref } from "vue";
import { openAgentConversation, useChat } from "../chat/useChat";
import { sandboxJson } from "../sandbox/sandboxClient";

/* The fleet store — the daemon's agent registry mirrored into the browser. Fed two ways: the /events stream's
 * `agents` roster snapshots (last frame wins, the presence pattern — see useSandboxLiveness) and an explicit
 * refresh() from GET /agents on the reachable seam. The FLEET view merges the registry (authoritative:
 * status/branch/cost, agents this tab never opened) with the open Conversation tabs by conversationId (live:
 * in-browser streaming state). Module-level singleton, like useChat. */

const registry = ref<AgentSummary[]>([]);

// Roster snapshot from the events stream (or refresh) — full-replace, last frame wins.
export const setAgents = (agents: AgentSummary[]): void => {
    registry.value = agents;
};

// A disconnected roster is meaningless; the reconnect's immediate snapshot repaints it.
export const resetAgents = (): void => {
    registry.value = [];
};

// Unread tracking: an agent whose updatedAt outruns the last time this browser opened it, while it isn't
// running, "has something for you". Persisted per browser (not per sandbox — conversation ids are unique).
const SEEN_KEY = `intentic.agentsSeen`;
const readSeen = (): Record<string, number> => {
    try {
        const raw = localStorage.getItem(SEEN_KEY);
        return raw === null ? {} : (JSON.parse(raw) as Record<string, number>);
    } catch {
        return {};
    }
};
const seen = ref<Record<string, number>>(readSeen());
const markSeen = (id: string): void => {
    seen.value = { ...seen.value, [id]: Date.now() };
    try {
        localStorage.setItem(SEEN_KEY, JSON.stringify(seen.value));
    } catch {
        // Storage may be unavailable (private mode); the in-memory map still holds.
    }
};

// One fleet entry: the registry summary, joined (when this browser has the conversation open) with its live
// Conversation for drill-in and local streaming state.
export interface FleetAgent extends AgentSummary {
    readonly open: boolean;
    readonly unread: boolean;
}

const fleet = computed<FleetAgent[]>(() => {
    const { conversations } = useChat();
    const openIds = new Set(conversations.value.map((conversation) => conversation.conversationId));
    return registry.value
        .map((agent) => ({
            ...agent,
            open: openIds.has(agent.id),
            unread: agent.status !== `running` && agent.updatedAt > (seen.value[agent.id] ?? 0),
        }))
        .toSorted((a, b) => {
            // Attention first, then running, then most recently active.
            const weight = (entry: FleetAgent): number =>
                entry.attention.plan || entry.attention.question || entry.attention.conflict || entry.status === `error`
                    ? 0
                    : entry.status === `running` || entry.status === `awaiting`
                      ? 1
                      : 2;
            return weight(a) - weight(b) || b.updatedAt - a.updatedAt;
        });
});

// The single "agents need you" aggregate the rail tile and mobile tab badge render: one count per agent that
// has a pending plan/question, a land conflict, an error, or unread activity.
const attention = computed(
    () =>
        fleet.value.filter(
            (agent) => agent.attention.plan || agent.attention.question || agent.attention.conflict || agent.status === `error` || agent.unread,
        ).length,
);

// Explicit registry pull — the reachable seam and pull-to-refresh use it; steady-state updates ride /events.
const refresh = async (): Promise<void> => {
    try {
        const body = await sandboxJson<{ agents: AgentSummary[] }>(`/agents`);
        registry.value = body.agents;
    } catch {
        // Leave the last roster; the events stream repaints on reconnect.
    }
};

// Open (or focus) an agent's conversation tab and mark it seen.
const open = (agent: AgentSummary): void => {
    openAgentConversation({
        id: agent.id,
        provider: agent.provider,
        harness: agent.harness,
        ...(agent.sessionId !== undefined ? { sessionId: agent.sessionId } : {}),
        ...(agent.title !== undefined ? { title: agent.title } : {}),
        ...(agent.account !== undefined ? { account: agent.account } : {}),
    });
    markSeen(agent.id);
};

export function useAgents() {
    return { fleet, attention, refresh, open, markSeen };
}
