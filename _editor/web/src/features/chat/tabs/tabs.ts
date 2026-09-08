import type { AgentOrigin } from "@intentic/sandbox-contract";
import { useAgents } from "../../agents/fleet/useAgents";
import type { FleetAgent } from "../../agents/fleet/useAgents-fleet";
import { type FleetLane, laneOf, NO_ATTENTION } from "../../agents/fleet/agentStatus";
import type { Conversation } from "../session/conversation";
import { draftPreview } from "../drafts/draftPreview";
import { useChat } from "../run/useChat";
import { standingOf, tabFacts, untouched } from "./tabFacts";

// Facts the open-chat list and header both need, kept as projections rather than component state, so the two
// surfaces (and the close-set menus) read the same thing instead of duplicating it.

// What a tab calls a conversation: derived title, else the draft preview, else "New agent"/"New chat". A
// stand-in title, replaced (not merged) the moment a real one arrives.
export const tabLabel = (conversation: Conversation): string =>
    conversation.title.value ?? draftPreview(conversation.draft.value) ?? (conversation.isolated.value ? `New agent` : `New chat`);

// Opened by an outside message (a Discord mention, a visitor, a webhook) rather than the user; read from the
// fleet registry, since a plain conversation carries no origin of its own.
export const originOf = (conversation: Conversation): AgentOrigin | undefined => useAgents().agentById(conversation.conversationId)?.origin;

// Off the board though still open: reopened from the archive, or its agent has since been swept there.
// Distinguishes it from a live agent's chat.
export const isArchived = (conversation: Conversation): boolean => useAgents().agentById(conversation.conversationId)?.archivedAt !== undefined;

// Same lane as the board's card, from the same rule (laneOf), over the best card available here, in the order of
// what each can know:
// - the fleet's own entry, whenever this window's roster holds one
// - what this window can see for itself: a turn running or refused right here outranks any older account
// - the standing the card carried in when it opened the chat (Conversation.standing), for a roster that hasn't
//   answered in this window — the one thing that keeps a popped-out chat from re-deciding the lane alone
// - failing all three, the client standing the board's own draft card would carry (tabFacts.standingOf)
// A second rule here is how one conversation sat in Attention on the board and Finished in the switcher.
export const laneOfTab = (conversation: Conversation, agent: FleetAgent | undefined): FleetLane => {
    if (agent !== undefined) {
        return laneOf(agent);
    }
    const here = standingOf(conversation);
    if (here === `starting` || here === `failed`) {
        return laneOf({ status: here, attention: NO_ATTENTION });
    }
    return laneOf(conversation.standing.value ?? { status: here, attention: NO_ATTENTION });
};

// Close sets read the live conversation list at call time, not a snapshot, so a chat arriving while the menu
// is open is still included. No close confirms: a chat's turn is detached daemon-side (soft abort) and keeps
// working, reopenable from History.
export const othersOf = (id: string): ReadonlySet<string> =>
    new Set(
        useChat()
            .conversations.value.filter((conversation) => conversation.conversationId !== id)
            .map((conversation) => conversation.conversationId),
    );

export const toRightOf = (id: string): ReadonlySet<string> => {
    const list = useChat().conversations.value;
    const index = list.findIndex((conversation) => conversation.conversationId === id);
    return new Set(index === -1 ? [] : list.slice(index + 1).map((conversation) => conversation.conversationId));
};

export const allTabs = (): ReadonlySet<string> => new Set(useChat().conversations.value.map((conversation) => conversation.conversationId));

// Every chat in one lane, for either surface: the sweep Close Others/Close to the Right can't express. An
// untouched draft is left out (it goes on its own the moment focus leaves); the active chat is not spared.
export const tabsInLane = (lane: FleetLane): ReadonlySet<string> => {
    const { agentById } = useAgents();
    return new Set(
        useChat()
            .conversations.value.filter(
                (conversation) =>
                    !untouched(tabFacts(conversation)) && laneOfTab(conversation, agentById(conversation.conversationId)) === lane,
            )
            .map((conversation) => conversation.conversationId),
    );
};
