import type { HeldCards, HeldOutcome } from "./held-cards.js";

// THE ONE LIFECYCLE OF A GATE'S CARD, for every gate that asks a person mid-call (a device command, a secret's host
// guard, a credential's release, a payment, a new sandbox). A card waits for its answer (guard/card-offers.ts); the call
// that raised it may not: a device call has under a minute before the agent's MCP client reports a timeout, and a CLI's
// connection goes when its job is stopped or the agent moves on. So the card outlives the call:
// - the same call again, while its card is open or its answer uncollected, waits on that card instead of raising a
//   second one, and collects its answer once;
// - the card is held for the turn's close (guard/held-cards.ts), which keeps the turn open, parked on it, until it
//   settles, and wakes the conversation with what the card's gate words: a yes kept for that exact call and used once
//   by the turn the wake starts, or a decline with the owner's note;
// - it settles unanswered only when the turn is stopped (the close cancels it), the turn is over, or the conversation
//   is gone (its cards are let go). No clock refuses it.
// One registry per gate, each with its own keys, so two gates never share a card.

// What a gate holds its cards with: the turn close's registry, and when a conversation's live turn is over (undefined
// where none is live), as composition.ts wires them from the conversations.
export interface HoldDeps {
    readonly held: Pick<HeldCards, "add">;
    readonly finished: (conversationId: string) => Promise<void> | undefined;
}

// HoldDeps from the turn close's registry and a way to find a conversation's turn: what a route or slice wires.
export const holdDepsOf = (
    held: Pick<HeldCards, "add">,
    turnRun: (conversationId: string) => { readonly waitUntilFinished: () => Promise<void> } | undefined,
): HoldDeps => ({ held, finished: (conversationId) => turnRun(conversationId)?.waitUntilFinished() });

export interface HeldAnswer<Answer> {
    // What the call answers.
    readonly answer: Answer;
    // What a turn holding for the card wakes its conversation with.
    readonly outcome: HeldOutcome;
}

export interface AskCall<Answer> {
    readonly conversationId: string;
    // The exact call within its conversation: the same key again waits on the same card.
    readonly key: string;
    // What the call answers when it stops waiting before the card settles: nothing happened, the card is still up.
    readonly waiting: () => Answer;
    // How long this call may wait, from `arrivedAt`; none waits until the card settles or `signal` ends the call.
    readonly budgetMs?: number;
    readonly arrivedAt?: number;
    // The caller's own lifetime: its abort ends the wait, never the card.
    readonly signal?: AbortSignal;
}

export interface CardToHold<Answer> {
    // Raises the card; `ended` settles it unanswered (the turn's close was stopped, or the turn is over).
    readonly raise: (ended: AbortSignal) => Promise<HeldAnswer<Answer>>;
    // What the wake tells the agent of the card's outcome (held-cards.ts wakeWords); undefined wakes nobody.
    readonly told: (outcome: HeldOutcome) => string | undefined;
    readonly held: Pick<HeldCards, "add">;
    // When the turn the card went up in is over, where the gate knows it; the close's own hold bounds it otherwise.
    readonly finished?: Promise<void> | undefined;
}

export interface HeldAsks<Answer> {
    // The same call's card, still open or answered and not yet collected: waits on it, or undefined where there is none.
    readonly reattach: (call: AskCall<Answer>) => Promise<Answer> | undefined;
    // Raises the card, holds it for the turn's close, and waits on it as `call` may.
    readonly ask: (call: AskCall<Answer>, card: CardToHold<Answer>) => Promise<Answer>;
}

// How long a yes the close carried waits for the turn its wake starts to make the call again. Not a refusal: past it,
// the same call is asked about afresh.
export const CARRY_MS = 10 * 60_000;

interface Open<Answer> {
    // Settles with the answer; `settled` is set in the same step, before any waiter resumes.
    readonly done: Promise<unknown>;
    settled: { readonly answer: Answer } | undefined;
    // Calls waiting on it right now: an answer that lands while one waits is that call's, and wakes nobody.
    waiting: number;
    delivered: boolean;
    // Drops the held card once a call has the answer.
    readonly release: () => void;
}

const GAVE_UP = Symbol("gave up");

export const createHeldAsks = <Answer>(carryMs: number = CARRY_MS): HeldAsks<Answer> => {
    const open = new Map<string, Open<Answer>>();
    const fullKey = (call: Pick<AskCall<Answer>, "conversationId" | "key">): string => `${call.conversationId}\u0000${call.key}`;
    // Only the entry that was there goes: a newer card under the same key outlives the old one's end.
    const drop = (key: string, entry: Open<Answer>): void => {
        if (open.get(key) === entry) {
            open.delete(key);
        }
    };
    const collect = async (key: string, entry: Open<Answer>, call: AskCall<Answer>): Promise<Answer> => {
        entry.waiting += 1;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let stop: (() => void) | undefined;
        try {
            const gaveUp = new Promise<typeof GAVE_UP>((resolve) => {
                stop = () => resolve(GAVE_UP);
                if (call.budgetMs !== undefined) {
                    timer = setTimeout(stop, Math.max(0, call.budgetMs - (Date.now() - (call.arrivedAt ?? Date.now()))));
                }
                if (call.signal?.aborted === true) {
                    resolve(GAVE_UP);
                }
                call.signal?.addEventListener("abort", stop, { once: true });
            });
            await Promise.race([entry.done, gaveUp]);
            // An answer that landed while this call waited is this call's, even when its budget ran out in the same step.
            if (entry.settled === undefined) {
                return call.waiting();
            }
            drop(key, entry);
            entry.release();
            return entry.settled.answer;
        } finally {
            entry.waiting -= 1;
            clearTimeout(timer);
            if (stop !== undefined) {
                call.signal?.removeEventListener("abort", stop);
            }
        }
    };
    // A yes kept past its turn's end for the turn the wake starts: already answered, held by nobody, used once.
    const carry = (key: string, answer: Answer): void => {
        const carried: Open<Answer> = { done: Promise.resolve(), settled: { answer }, waiting: 0, delivered: false, release: () => undefined };
        open.set(key, carried);
        setTimeout(() => drop(key, carried), carryMs).unref();
    };
    return {
        reattach: (call) => {
            const key = fullKey(call);
            const entry = open.get(key);
            return entry === undefined ? undefined : collect(key, entry, call);
        },
        ask: (call, card) => {
            const key = fullKey(call);
            const ended = new AbortController();
            void card.finished?.then(() => ended.abort());
            let release = (): void => undefined;
            const settles = card.raise(ended.signal).then((raised) => {
                entry.settled = { answer: raised.answer };
                entry.delivered = entry.waiting > 0;
                // Nobody answered: a later call asks afresh rather than collecting a refusal nobody gave.
                if (raised.outcome.decision === "unanswered" && !entry.delivered) {
                    drop(key, entry);
                }
                return raised.outcome;
            });
            const entry: Open<Answer> = { done: settles, settled: undefined, waiting: 0, delivered: false, release: () => release() };
            open.set(key, entry);
            release = card.held.add(call.conversationId, {
                // A call that has the answer already needs no wake about it.
                told: (said) => (entry.delivered ? undefined : card.told(said)),
                settled: settles,
                cancel: () => ended.abort(),
                carry: () => {
                    if (!entry.delivered && entry.settled !== undefined && open.get(key) === entry) {
                        carry(key, entry.settled.answer);
                    }
                },
            });
            // An answer nobody came back for is dropped with its turn, unless the close carried a yes over.
            void card.finished?.then(() => {
                release();
                drop(key, entry);
            });
            return collect(key, entry, call);
        },
    };
};
