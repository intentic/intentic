import type { AgentOrigin } from "@intentic/sandbox-contract";
import { type FleetAgent, useAgents } from "../agents/useAgents";
import { type FleetLane, laneOf } from "../agents/agentStatus";
import type { Conversation } from "./conversation";
import { draftPreview } from "./draftEcho";
import { useChat } from "./useChat";

/* What the open-chat list KNOWS about a tab, as projections rather than as component state, because two
 * surfaces read them and they must agree. The chat panel's header names the active conversation (its title,
 * its origin, whether it is archived) and the list beneath it draws the same facts per row; the close sets
 * are asked for by the keyboard commands (which act on the ACTIVE chat) and by a row's right-click menu
 * (which acts on the one under the pointer). When those lived in the strip component, the header could only
 * get at them by being the same file, which is what kept a 1000-line component from being split. */

/* What a tab calls a conversation: its derived title, else the words it is holding, else the noun for where it
 * works, an untitled isolated conversation IS a draft agent card on the fleet board.
 *
 * THE COMPOSER NAMES A CHAT THAT NOTHING ELSE HAS NAMED YET. A title arrives with the first turn, so a strip of
 * chats waiting to be sent read "New agent, New agent, New agent" at the exact moment the reader has to tell
 * them apart, and the one thing that would have told them apart, the message they just wrote, was on screen a
 * hand's width away. It is a stand-in and it is replaced, not merged: the moment a turn earns a real title
 * (or the user renames it) that wins, here as everywhere. */
export const tabLabel = (conversation: Conversation): string =>
    conversation.title.value ?? draftPreview(conversation.draft.value) ?? (conversation.isolated.value ? `New agent` : `New chat`);

// Opened by an outside message (a Discord mention, a visitor, a webhook) rather than by the user. The registry
// entry is where that fact lives, so it is read from the fleet; the surfaces wear the source glyph alone,
// since the title of such a chat already leads with who sent the message.
export const originOf = (conversation: Conversation): AgentOrigin | undefined => useAgents().agentById(conversation.conversationId)?.origin;

// Off the board, still open. Archiving CLOSES an agent's chat (see the archive note in useAgents), so what
// lands here is the other way round: one opened FROM the archive, or one whose agent the daemon's retention
// sweep filed away. A chat that looks identical to a live agent is how "didn't I just archive that?" starts.
export const isArchived = (conversation: Conversation): boolean => useAgents().agentById(conversation.conversationId)?.archivedAt !== undefined;

/* Which lane a TAB belongs to. laneOf is the board's own projection, so a chat can never sit in a different
 * lane here than its card does on /agents. A conversation the fleet has never carded (a plain non-isolated
 * chat, or the roster briefly down) still needs a shelf: streaming or empty reads as Active, anything else as
 * Finished. The list groups its cards by this, and "Close Finished" takes exactly the lane it names, one
 * definition of "finished", so the menu row can't close a card the list is still showing as Active. */
export const laneOfTab = (conversation: Conversation, agent: FleetAgent | undefined): FleetLane => {
    if (agent !== undefined) {
        return laneOf(agent);
    }
    return conversation.streaming.value || conversation.messages.value.length === 0 ? `active` : `finished`;
};

/* THE CLOSE SETS, named the way the menu names them. Each reads the LIVE conversation list at call time rather
 * than a snapshot taken when a menu opened, so a chat that arrives while the menu sits open (an inbound
 * mention opens one) is folded into the set instead of escaping it.
 *
 * No close asks for a confirm, mass or single, unlike the workspace's file tabs, where closing discards
 * unsaved edits, closing a chat destroys nothing. A running agent's turn is detached daemon-side
 * (Conversation.abort is soft by design), so it keeps working and lands its work with the chat closed; the
 * conversation stays in the sandbox's store, and reopening it from History reattaches to the still-live turn. */
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

/* Every chat that has stopped working, the Finished lane, whichever surface is asking. This is the sweep a
 * long session actually wants: a dozen chats accumulate, two are still running, and neither Close Others nor
 * Close to the Right can express "clear the done ones" without hunting for them one × at a time. The ACTIVE
 * chat is not spared if it is finished; being the one you are looking at is not a reason to keep a landed
 * agent open, and closing it selects the last survivor the way every other close here does. */
export const finishedTabs = (): ReadonlySet<string> => {
    const { agentById } = useAgents();
    return new Set(
        useChat()
            .conversations.value.filter((conversation) => laneOfTab(conversation, agentById(conversation.conversationId)) === `finished`)
            .map((conversation) => conversation.conversationId),
    );
};
