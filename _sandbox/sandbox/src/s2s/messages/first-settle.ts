import type { S2sOutbox, Settled } from "./outbox.js";

// WHAT A SEND'S FIRST ATTEMPT CAME TO, for a sender that answers its caller in words (a report handed on from the account
// outbox, a drop sent as a message): the outbox tries an entry at once in the background, and this waits a little for
// that try to say sent, kept for later or refused. One listener per outbox, which remembers the latest outcomes, so a
// try that settled before anyone asked is still found. An entry held without a try (a key to trust, an accept to wait
// for) says nothing, and the wait runs out: the caller says it waits.

const KEPT = 200;

interface Watch {
    readonly recent: Map<string, Settled>;
    readonly waiting: Map<string, ((settled: Settled) => void)[]>;
}

// allow(module-state): one listener per outbox instance, held as long as the outbox is.
const watches = new WeakMap<Pick<S2sOutbox, "onSettled">, Watch>();

const watchOf = (outbox: Pick<S2sOutbox, "onSettled">): Watch => {
    const known = watches.get(outbox);
    if (known !== undefined) {
        return known;
    }
    const watch: Watch = { recent: new Map(), waiting: new Map() };
    outbox.onSettled(async (entry, settled) => {
        watch.recent.set(entry.id, settled);
        for (const stale of [...watch.recent.keys()].slice(0, Math.max(0, watch.recent.size - KEPT))) {
            watch.recent.delete(stale);
        }
        for (const resolve of watch.waiting.get(entry.id) ?? []) {
            resolve(settled);
        }
        watch.waiting.delete(entry.id);
    });
    watches.set(outbox, watch);
    return watch;
};

/** Starts remembering what the outbox's attempts come to; call it before the enqueue whose outcome is wanted. */
export const watchSettles = (outbox: Pick<S2sOutbox, "onSettled">): void => {
    watchOf(outbox);
};

/** The entry's first outcome, or undefined when none came within `ms`. */
export const firstSettle = async (outbox: Pick<S2sOutbox, "onSettled">, id: string, ms: number): Promise<Settled | undefined> => {
    const watch = watchOf(outbox);
    const seen = watch.recent.get(id);
    if (seen !== undefined) {
        return seen;
    }
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            watch.waiting.set(id, (watch.waiting.get(id) ?? []).filter((each) => each !== done));
            resolve(undefined);
        }, ms);
        const done = (settled: Settled): void => {
            clearTimeout(timer);
            resolve(settled);
        };
        watch.waiting.set(id, [...(watch.waiting.get(id) ?? []), done]);
    });
};
