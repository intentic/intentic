import type { AgentOrigin } from "@intentic/sandbox-contract";
import { useAgents } from "../../agents/fleet/useAgents";
import type { FleetAgent } from "../../agents/fleet/useAgents-fleet";
import { type FleetLane, laneOf, NO_ATTENTION, unregistered } from "../../agents/fleet/agentStatus";
import type { Conversation } from "../session/conversation";
import { draftPreview } from "../drafts/draftPreview";
import { useChat } from "../run/useChat";
import { standingOf, untouchedDraft } from "./tabFacts";

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

// Every sweep reads the live list at call time and skips a pinned chat: only a pinned chat's own Close takes it.
const sweepable = (): Conversation[] => useChat().conversations.value.filter((conversation) => !conversation.pinned.value);
const idsOf = (list: readonly Conversation[]): ReadonlySet<string> => new Set(list.map((conversation) => conversation.conversationId));

export const othersOf = (id: string): ReadonlySet<string> => idsOf(sweepable().filter((conversation) => conversation.conversationId !== id));

export const toRightOf = (id: string): ReadonlySet<string> => {
    const list = useChat().conversations.value;
    const index = list.findIndex((conversation) => conversation.conversationId === id);
    return idsOf(index === -1 ? [] : list.slice(index + 1).filter((conversation) => !conversation.pinned.value));
};

export const allTabs = (): ReadonlySet<string> => idsOf(sweepable());

// Every chat in one lane, for either surface: the sweep Close Others/Close to the Right can't express. An
// untouched draft is left out (it goes on its own the moment focus leaves); the active chat is not spared.
export const tabsInLane = (lane: FleetLane): ReadonlySet<string> => {
    const { agentById } = useAgents();
    return idsOf(
        sweepable().filter(
            (conversation) => !untouchedDraft(conversation) && laneOfTab(conversation, agentById(conversation.conversationId)) === lane,
        ),
    );
};

// Who a conversation speaks as, by the daemon's one field: the persona its last turn ran as (each turn runs as its own).
// A sandbox too old to send it groups nothing under a persona, and the rail says it needs an update (ChatPersonaRail).
export const personaOfAgent = (agent: Pick<FleetAgent, "lastActsAs">): string | undefined => agent.lastActsAs;

// The persona a chat sits under in the Personas cut: the daemon's word for a conversation it holds, and only for a draft
// it has never seen, the pick its first turn will run as. A persona naming no card on file sits with Anyone, so the cut
// always holds every open chat exactly once.
export const personaOfTab = (conversation: Conversation, known: ReadonlySet<string>): string | undefined => {
    const agent = useAgents().agentById(conversation.conversationId);
    const persona = agent !== undefined && !unregistered(agent.status) ? personaOfAgent(agent) : conversation.selection.actsAs.value;
    return persona !== undefined && known.has(persona) ? persona : undefined;
};

// One persona's sweepable chats, optionally one lane of them: the persona header's own Close verbs.
export const tabsOfPersona = (persona: string | undefined, known: ReadonlySet<string>, lane?: FleetLane): ReadonlySet<string> => {
    const { agentById } = useAgents();
    return idsOf(
        sweepable().filter(
            (conversation) =>
                !untouchedDraft(conversation) &&
                personaOfTab(conversation, known) === persona &&
                (lane === undefined || laneOfTab(conversation, agentById(conversation.conversationId)) === lane),
        ),
    );
};
