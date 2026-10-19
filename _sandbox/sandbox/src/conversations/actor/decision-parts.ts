import type { ConversationState } from "./conversation-state.js";
import type { ConversationEffect, Decision } from "./conversation-decide.js";

// What every reducer of a conversation's events answers with (conversation-decide.ts), shared with the ones kept beside
// it (held-decide.ts).

// The state, changed or not, with nothing to do and the sender's answer.
export const unchanged = <R>(state: ConversationState, reply: R): Decision<R> => ({ state, effects: [], reply });

// Tells every window, and nothing else.
export const BROADCAST: readonly ConversationEffect[] = [{ kind: "broadcast" }];

// The state with its held-turn records moved.
export const withResume = (state: ConversationState, resume: Partial<ConversationState["resume"]>): ConversationState => ({
    ...state,
    resume: { ...state.resume, ...resume },
});
