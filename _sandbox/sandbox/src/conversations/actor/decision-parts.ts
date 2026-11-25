import type { ConversationState } from "./conversation-state.js";
import type { ConversationEffect, Decision } from "./conversation-decide.js";
import type { TurnQueue } from "./conversation-queue.js";

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

// A queue that moved is written onto the entry, persisted, and shown, in that order; one that did not writes nothing.
export const queueWrites = (before: TurnQueue, after: TurnQueue): readonly ConversationEffect[] =>
    before === after ? [] : [{ kind: "queue-written", queue: after }, { kind: "persist" }];

// The state with this queue, written and shown where it moved; the same state, and nothing to do, where it did not.
export const withQueue = <R>(state: ConversationState, queue: TurnQueue, reply: R): Decision<R> =>
    queue === state.queue
        ? unchanged(state, reply)
        : { state: { ...state, queue }, effects: [...queueWrites(state.queue, queue), ...BROADCAST], reply };
