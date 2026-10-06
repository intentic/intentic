import type { Services } from "../../composition.js";
import type { CardDeps } from "../../guard/card-offers.js";
import type { ConversationActors } from "./conversation-actors.js";
import { soleLiveConversation, turnRunOf } from "./conversation-holdings.js";

// The real CardDeps a gate raises its cards through (guard/card-offers.ts has the mechanics): where a card lands, how
// its frames reach the conversation's actor, and how the owner's devices hear of it.

// The real `observe`: every frame raised outside the pump reaches the conversation's actor as its own frames do.
export const actorObserver =
    (conversations: Pick<ConversationActors, "send">): CardDeps["observe"] =>
    (conversationId, event) =>
        void conversations.send(conversationId, { kind: "frame", frame: event });

// The real `liveRun`: falls back to the sole live conversation when the caller named none, and refuses to guess between
// two live runs.
export const liveRequestRun =
    (conversations: Pick<ConversationActors, "holdings">): CardDeps["liveRun"] =>
    (conversationId) => {
        const id = conversationId ?? soleLiveConversation(conversations);
        const run = id === undefined ? undefined : turnRunOf(conversations, id);
        return id === undefined || run === undefined || run.done ? undefined : { conversationId: id, push: (event) => run.push(event) };
    };

// The real seams, as every gate that raises a card outside the turn generator takes them.
export const cardDeps = (services: Pick<Services, "conversations" | "cards" | "events">): CardDeps => ({
    liveRun: liveRequestRun(services.conversations),
    observe: actorObserver(services.conversations),
    cards: services.cards,
    awaiting: (conversationId, kind, insist) =>
        services.events.publish("turn.awaiting", { conversationId, awaiting: kind, ...(insist === true ? { insist } : {}) }),
});
