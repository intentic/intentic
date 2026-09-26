import type { Holding, Holdings, HoldingsIndex } from "./conversation-holdings.js";

// A conversation's deadline: one timer per conversation per kind, set for the exact instant something is due, instead
// of a pass that polls every conversation on an interval to ask whether it is. Held like any other thing a conversation
// holds, so disposing the conversation clears its timer. Every fire of one kind runs after the last one settled, so two
// deadlines due together never race on what they share (an account's allowance, a CLI's spawn).

interface Pending {
    readonly at: number;
    readonly timer: NodeJS.Timeout;
}

export type DeadlineKind = Holding<Pending>;

/** Declares a kind of deadline, once, by the module whose deadline it is. */
export const deadlineKind = (name: string): DeadlineKind => ({ name, dropped: (pending) => clearTimeout(pending.timer) });

export interface Deadlines {
    // Sets this conversation's deadline of the kind, replacing any it had; `fire` runs once, at `at`.
    readonly set: (conversationId: string, at: number, fire: () => Promise<void>, now?: number) => void;
    readonly clear: (conversationId: string) => void;
    // When this conversation's deadline of the kind falls; undefined when none is set.
    readonly at: (conversationId: string) => number | undefined;
    // Every one of the kind, for a daemon shutting down.
    readonly clearAll: () => void;
}

// setTimeout's ceiling (about 24.8 days): a later deadline fires early, and its `fire` finds nothing due yet.
const MAX_DELAY_MS = 2_147_483_647;

// The fires of one kind, chained, per conversations index.
const chains = new WeakMap<Holdings<Pending>, { tail: Promise<void> }>();

// `failed` hears a fire that threw, by the conversation it was for; the next fire runs regardless.
export const deadlines = (conversations: Pick<HoldingsIndex, "holdings">, kind: DeadlineKind, failed: (conversationId: string, error: Error) => void): Deadlines => {
    const held = conversations.holdings(kind);
    const chain = chains.get(held) ?? { tail: Promise.resolve() };
    chains.set(held, chain);
    const clear = (conversationId: string): void => {
        const pending = held.get(conversationId);
        if (pending !== undefined) {
            clearTimeout(pending.timer);
            held.drop(conversationId);
        }
    };
    return {
        set: (conversationId, at, fire, now = Date.now()) => {
            clear(conversationId);
            const timer = setTimeout(
                () => {
                    held.drop(conversationId);
                    chain.tail = chain.tail.then(async () => {
                        try {
                            await fire();
                        } catch (error) {
                            failed(conversationId, error instanceof Error ? error : new Error(String(error)));
                        }
                    });
                },
                Math.min(MAX_DELAY_MS, Math.max(0, at - now)),
            );
            // Never a reason to keep the process up: what is due is the conversation's own state, read again at the fire.
            timer.unref();
            held.hold(conversationId, conversationId, { at, timer });
        },
        clear,
        at: (conversationId) => held.get(conversationId)?.at,
        clearAll: () => {
            for (const [conversationId] of held.entries()) {
                clear(conversationId);
            }
        },
    };
};
