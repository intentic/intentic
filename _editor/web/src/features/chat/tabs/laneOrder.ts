import { finishedLaneOrder } from "../../agents/fleet/useAgents-fleet";
import type { OpenChat } from "./cardView";
import { laneOfTab } from "./tabs";

// Open chats split into the board's three lanes and put in the board's order (useAgents.lanes), for both cuts of the
// rail: the Agents cut draws the lanes, the Personas cut draws one persona's chats lane after lane. One rule, so a chat
// sits beside the same neighbours whichever cut draws it, and no working chat climbs the list each time it streams.
// A chat with no roster entry is read off its conversation instead.

const lastActive = (entry: OpenChat): number => entry.agent?.updatedAt ?? 0;

// Keyed by the board's lanes (FleetLane), each in the order it is drawn.
export interface ChatLanes {
    readonly attention: OpenChat[];
    readonly active: OpenChat[];
    readonly finished: OpenChat[];
}

export const laneOrdered = (entries: Iterable<OpenChat>): ChatLanes => {
    const grouped: ChatLanes = { attention: [], active: [], finished: [] };
    for (const entry of entries) {
        grouped[laneOfTab(entry.conversation, entry.agent)].push(entry);
    }
    // Drafts lead Active, then turn start, fixed for the turn.
    grouped.active.sort(
        (a, b) =>
            Number(b.agent?.status === `draft`) - Number(a.agent?.status === `draft`) ||
            (a.agent?.startedAt ?? lastActive(a)) - (b.agent?.startedAt ?? lastActive(b)),
    );
    grouped.attention.sort((a, b) => lastActive(b) - lastActive(a));
    // The board's finishedLaneOrder; agent-less chats fall back to the same two keys read off the conversation.
    grouped.finished.sort((a, b) => {
        if (a.agent !== undefined && b.agent !== undefined) {
            return finishedLaneOrder(a.agent, b.agent);
        }
        return Number(b.conversation.unsent.value) - Number(a.conversation.unsent.value) || lastActive(b) - lastActive(a);
    });
    // Pinned chats lead their lane; the sort is stable, so each side keeps the lane's own order.
    for (const lane of [grouped.attention, grouped.active, grouped.finished]) {
        lane.sort((a, b) => Number(b.conversation.pinned.value) - Number(a.conversation.pinned.value));
    }
    return grouped;
};

// The lanes as the reader last saw them, while they are reading (the pointer is over the list): each lane keeps the
// order it was drawn in, a chat that left it goes, and one that joined it waits at the foot, so a press never lands on a
// card that moved under it. With nothing held, the fresh order stands.
export const steadyLanes = (fresh: ChatLanes, held: ChatLanes | undefined): ChatLanes => {
    if (held === undefined) {
        return fresh;
    }
    const steady = (lane: keyof ChatLanes): OpenChat[] => {
        const now = new Map(fresh[lane].map((entry) => [entry.conversation.conversationId, entry]));
        const kept = held[lane].flatMap((entry) => now.get(entry.conversation.conversationId) ?? []);
        const seen = new Set(kept.map((entry) => entry.conversation.conversationId));
        return [...kept, ...fresh[lane].filter((entry) => !seen.has(entry.conversation.conversationId))];
    };
    return { attention: steady(`attention`), active: steady(`active`), finished: steady(`finished`) };
};
