import type { AgentOrigin } from "@intentic/sandbox-contract";
import { useAgents } from "../../agents/fleet/useAgents";
import type { FleetAgent } from "../../agents/fleet/useAgents-fleet";
import { type FleetLane, laneOf } from "../../agents/fleet/agentStatus";
import type { Conversation } from "../session/conversation";
import { draftPreview } from "../drafts/draftPreview";
import { useChat } from "../run/useChat";

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

// Same lane as the board's card (laneOf), so a chat never disagrees with /agents. An uncarded conversation
// (plain chat, roster down) reads streaming-or-empty as Active, else Finished.
export const laneOfTab = (conversation: Conversation, agent: FleetAgent | undefined): FleetLane => {
    if (agent !== undefined) {
        return laneOf(agent);
    }
    return conversation.streaming.value || conversation.messages.value.length === 0 ? `active` : `finished`;
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

// Every chat in the Finished lane, for either surface: the sweep Close Others/Close to the Right can't
// express. The active chat is not spared; closing it selects the last survivor like any other close.
export const finishedTabs = (): ReadonlySet<string> => {
    const { agentById } = useAgents();
    return new Set(
        useChat()
            .conversations.value.filter((conversation) => laneOfTab(conversation, agentById(conversation.conversationId)) === `finished`)
            .map((conversation) => conversation.conversationId),
    );
};
