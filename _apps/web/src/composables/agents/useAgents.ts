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

// One fleet entry. Two sources merged by conversationId: the registry (authoritative once a turn has run) and
// the open tabs — an open ISOLATED conversation with no registry entry yet is a DRAFT card, so "New agent" has
// a visible result on the board the instant it's pressed. `status` widens the wire enum with that
// client-only draft state; the registry wins the merge the moment the first turn registers the conversation.
export interface FleetAgent extends Omit<AgentSummary, "status"> {
    readonly status: AgentSummary["status"] | "draft";
    readonly open: boolean;
    readonly unread: boolean;
}

// Attention first, then running + fresh drafts, then most recently active.
const weight = (entry: FleetAgent): number =>
    entry.attention.plan || entry.attention.question || entry.attention.conflict || entry.status === `error`
        ? 0
        : entry.status === `running` || entry.status === `awaiting` || entry.status === `draft`
          ? 1
          : 2;

const fleet = computed<FleetAgent[]>(() => {
    const { conversations } = useChat();
    const openIds = new Set(conversations.value.map((conversation) => conversation.conversationId));
    const registered = new Set(registry.value.map((agent) => agent.id));
    const drafts = conversations.value
        .filter((conversation) => conversation.isolated.value && !registered.has(conversation.conversationId))
        .map((conversation): FleetAgent => {
            const draft: FleetAgent = {
                id: conversation.conversationId,
                // A draft racing its first turn (begin → roster frame) already reads as running.
                status: conversation.streaming.value ? `running` : `draft`,
                provider: conversation.provider.value,
                harness: conversation.harness.value,
                updatedAt: 0,
                attention: { plan: false, question: false, conflict: false },
                open: true,
                unread: false,
            };
            if (conversation.title.value !== null) {
                draft.title = conversation.title.value;
            }
            return draft;
        });
    return [
        ...registry.value.map((agent) => ({
            ...agent,
            open: openIds.has(agent.id),
            unread: agent.status !== `running` && agent.updatedAt > (seen.value[agent.id] ?? 0),
        })),
        ...drafts,
    ].toSorted((a, b) => weight(a) - weight(b) || b.updatedAt - a.updatedAt);
});

// The single "agents need you" aggregate the rail tile and mobile tab badge render: one count per agent that
// has a pending plan/question, a land conflict, an error, or unread activity.
const attention = computed(
    () =>
        fleet.value.filter(
            (agent) => agent.attention.plan || agent.attention.question || agent.attention.conflict || agent.status === `error` || agent.unread,
        ).length,
);

// The kanban lanes — pure projections of the status machine, so "finished" needs no explicit action or
// timer: the auto-land flow flips a cleanly-completed turn to landed/idle within ms of it ending, and any
// follow-up message animates the card straight back to active. Unread stays a card badge, not a promotion.
export type FleetLane = "attention" | "active" | "finished";
export const laneOf = (agent: Pick<FleetAgent, "status" | "attention">): FleetLane => {
    if (agent.attention.plan || agent.attention.question || agent.attention.conflict) {
        return `attention`;
    }
    if (agent.status === `awaiting` || agent.status === `conflict` || agent.status === `error`) {
        return `attention`;
    }
    if (agent.status === `running` || agent.status === `draft`) {
        return `active`;
    }
    return `finished`; // landed | idle — the work is in the workspace (or there was none).
};

const lanes = computed<Record<FleetLane, FleetAgent[]>>(() => {
    const grouped: Record<FleetLane, FleetAgent[]> = { attention: [], active: [], finished: [] };
    for (const agent of fleet.value) {
        grouped[laneOf(agent)].push(agent);
    }
    // Fresh drafts lead the active lane (they're what the user just created); everything else newest-first.
    grouped.active.sort((a, b) => Number(b.status === `draft`) - Number(a.status === `draft`) || b.updatedAt - a.updatedAt);
    grouped.attention.sort((a, b) => b.updatedAt - a.updatedAt);
    grouped.finished.sort((a, b) => b.updatedAt - a.updatedAt);
    return grouped;
});

// Explicit registry pull — the reachable seam and pull-to-refresh use it; steady-state updates ride /events.
const refresh = async (): Promise<void> => {
    try {
        const body = await sandboxJson<{ agents: AgentSummary[] }>(`/agents`);
        registry.value = body.agents;
    } catch {
        // Leave the last roster; the events stream repaints on reconnect.
    }
};

// Open (or focus) an agent's conversation tab and mark it seen. Takes just the identity fields so registry
// cards and client-only draft cards both route through it.
const open = (agent: Pick<FleetAgent, "id" | "provider" | "harness" | "sessionId" | "title" | "account">): void => {
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
    return { fleet, lanes, attention, refresh, open, markSeen };
}
