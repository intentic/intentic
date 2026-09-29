// That a card in a chat was answered here, for whoever draws the conversation elsewhere (the board and the rail draw it
// un-parked at once: useAgents-provisional.answeredHere). A leaf on purpose: the chat's reply path cannot import the
// fleet store, which imports the chat.

// The board's flag an answer clears (AgentAttention), where the card has one; undefined for a payment or a hand-off.
export type AnsweredPark = "plan" | "question" | "permission" | "capability" | "credential";

type Listener = (conversationId: string, park: AnsweredPark | undefined) => void;

// The listeners of a one-way signal, registered once by the fleet store at load.
const listeners = new Set<Listener>();

export const onCardAnswered = (listener: Listener): (() => void) => {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
};

export const cardAnswered = (conversationId: string, park: AnsweredPark | undefined): void => {
    for (const listener of listeners) {
        listener(conversationId, park);
    }
};
