import type { AgentSummary } from "@intentic/sandbox-contract";
import { computed, ref, watch } from "vue";
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

// Unread tracking: an agent whose updatedAt outruns the last time it was OPENED, while it isn't running, "has
// something for you". The read marker itself lives on the daemon entry (AgentSummary.seenAt), not in this
// browser — read state is a fact about the work, so clearing site data, opening an incognito window, or
// switching to the phone must not resurrect a board full of "New" badges.
//
// Writes are optimistic: stamp the roster in place (the card repaints instantly — `registry` is a deep ref),
// then persist through the daemon, whose broadcast re-lands the same value on every other connected surface.
// Best-effort: a failed write only means the badge returns on the next roster frame, and a card with no
// registry entry is a draft — nothing to mark, nothing unread.
const markSeen = (id: string): void => {
    const entry = registry.value.find((agent) => agent.id === id);
    if (entry === undefined) {
        return;
    }
    entry.seenAt = Date.now();
    void sandboxJson(`/agents/${encodeURIComponent(id)}/seen`, { method: `POST` }).catch(() => undefined);
};

// The escape hatch a notification surface owes the user: clear the whole board at once instead of clicking
// through every card to silence the rail badge.
const markAllSeen = (): void => {
    const now = Date.now();
    for (const agent of registry.value) {
        agent.seenAt = now;
    }
    void sandboxJson(`/agents/seen`, { method: `POST` }).catch(() => undefined);
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

// "Blocked on you" — the agent literally cannot go on (or has failed) until you act. Deliberately NOT the same
// thing as unread, which only says you haven't looked at it yet: a board that tells the user seven finished
// agents "need you" teaches them to ignore the word.
const blocked = (agent: Pick<FleetAgent, "status" | "attention">): boolean =>
    agent.attention.plan || agent.attention.question || agent.attention.permission || agent.attention.conflict || agent.status === `error`;

// Attention first, then running + fresh drafts, then most recently active.
const weight = (entry: FleetAgent): number =>
    blocked(entry) ? 0 : entry.status === `running` || entry.status === `awaiting` || entry.status === `draft` ? 1 : 2;

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
                attention: { plan: false, question: false, permission: false, conflict: false },
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
            unread: agent.status !== `running` && agent.updatedAt > (agent.seenAt ?? 0),
        })),
        ...drafts,
    ].toSorted((a, b) => weight(a) - weight(b) || b.updatedAt - a.updatedAt);
});

// The board's two headline counts, kept apart on purpose (the header renders both): agents BLOCKED on the
// user, and agents merely unread.
const blocking = computed(() => fleet.value.filter(blocked).length);
const unread = computed(() => fleet.value.filter((agent) => agent.unread).length);
// The single aggregate the rail tile and mobile tab badge render — "there is something for you on the board",
// counted per AGENT so one that is both blocked and unread badges once.
const attention = computed(() => fleet.value.filter((agent) => blocked(agent) || agent.unread).length);

// A turn that finishes while you are WATCHING its conversation is not news — the reply is already on your
// screen, so the card must not flip to "New" under your cursor (and the rail must not badge it). Gated on the
// tab being VISIBLE: an agent that finishes while the app sits in a background tab or a locked phone is
// exactly what the badge exists for, even though its conversation is still technically the active one.
// (Guarded like the store read it replaced: this module also evaluates in the node test env.)
const visible = ref(true);
if (typeof document !== `undefined`) {
    const syncVisible = (): void => {
        visible.value = document.visibilityState === `visible`;
    };
    syncVisible();
    document.addEventListener(`visibilitychange`, syncVisible);
}
watch(
    () => {
        if (!visible.value) {
            return undefined;
        }
        const watched = fleet.value.find((agent) => agent.id === useChat().active.value.conversationId);
        return watched?.unread === true ? watched.id : undefined;
    },
    (id) => {
        if (id !== undefined) {
            markSeen(id);
        }
    },
);

// The kanban lanes — pure projections of the status machine, so "finished" needs no explicit action or
// timer: the auto-land flow flips a cleanly-completed turn to landed/idle within ms of it ending, and any
// follow-up message animates the card straight back to active. Unread stays a card badge, not a promotion.
export type FleetLane = "attention" | "active" | "finished";
export const laneOf = (agent: Pick<FleetAgent, "status" | "attention">): FleetLane => {
    if (blocked(agent) || agent.status === `awaiting` || agent.status === `conflict`) {
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
    // Fresh drafts lead the active lane (they're what the user just created). Below them, order by startedAt —
    // a turn's start is FIXED for its whole life, so a running agent holds its slot instead of jumping to the
    // top on every activity frame (updatedAt ticks every second, which churns the lane when many run at once).
    // Oldest-running leads; a draft has no startedAt, so it falls back to updatedAt but is already sorted ahead.
    grouped.active.sort(
        (a, b) => Number(b.status === `draft`) - Number(a.status === `draft`) || (a.startedAt ?? a.updatedAt) - (b.startedAt ?? b.updatedAt),
    );
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

// Rename an agent: sync the open conversation's title ref first (docked tab, detail header, and the
// localStorage tab snapshot all follow it), then write the registry through the daemon. A card with no
// registry entry is a draft — its title lives client-side and rides the next turn body — but the POST still
// fires best-effort to cover the send→first-roster-frame window where the entry exists but hasn't painted.
// Registered agents update optimistically; on failure both sides revert (re-resolved against the CURRENT
// roster — an SSE frame may have replaced it mid-flight) and the error propagates to the caller's inline UI.
const rename = async (id: string, title: string): Promise<void> => {
    const trimmed = title.trim();
    const { conversations } = useChat();
    const conversation = conversations.value.find((candidate) => candidate.conversationId === id);
    const previousTitle = conversation?.title.value ?? null;
    if (conversation !== undefined) {
        conversation.title.value = trimmed;
    }
    const post = (): Promise<AgentSummary> =>
        sandboxJson<AgentSummary>(`/agents/${encodeURIComponent(id)}/rename`, {
            method: `POST`,
            headers: { "content-type": `application/json` },
            body: JSON.stringify({ title: trimmed }),
        });
    const previous = registry.value.find((agent) => agent.id === id);
    if (previous === undefined) {
        void post().catch(() => undefined);
        return;
    }
    const revertTitle = previous.title;
    previous.title = trimmed; // registry is a deep ref — the in-place write repaints the fleet
    try {
        const summary = await post();
        registry.value = registry.value.map((agent) => (agent.id === id ? summary : agent));
    } catch (error) {
        // Revert on whatever the roster holds NOW — an SSE frame may have replaced the array (and `previous`).
        const target = registry.value.find((agent) => agent.id === id);
        if (target !== undefined) {
            target.title = revertTitle;
        }
        if (conversation !== undefined) {
            conversation.title.value = previousTitle;
        }
        throw error;
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
    return { fleet, lanes, attention, blocking, unread, refresh, open, markSeen, markAllSeen, rename };
}
