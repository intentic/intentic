// Policy for what happens when a command is invoked again while still running (parallel, serial, singleFlight, latest),
// named so a call site's intent is reviewable. A keyed policy scopes the rule per resource: different keys run
// concurrently, the same key collapses.

export type ConcurrencyPolicy<I> =
    // Every invocation runs independently, the default behaviour of a bare async function.
    | { readonly mode: "parallel" }
    // FIFO per key: every invocation runs, but never two at once and never out of order.
    | { readonly mode: "serial"; readonly key: (input: I) => string }
    // An invocation arriving mid-flight shares its promise; for reads where a second answer is identical anyway.
    | { readonly mode: "singleFlight"; readonly key: (input: I) => string }
    // At most one running and one queued per key; a new invocation replaces the queued one, inherits its waiters.
    | { readonly mode: "latest"; readonly key: (input: I) => string };

interface Waiter<O> {
    readonly resolve: (value: O) => void;
    readonly reject: (reason: unknown) => void;
}

interface Slot<I, O> {
    // The invocation currently executing, if any.
    inFlight?: Promise<O>;
    // `latest` only: the input waiting to run once the in-flight one settles, and everyone awaiting it.
    queued?: { input: I; waiters: Waiter<O>[] };
    // `serial` only: the never-rejecting tail of the chain to append the next invocation to.
    tail?: Promise<void>;
}

/** Wrap a command in a concurrency policy. The returned function keeps the original signature. */
export const withConcurrency = <I, O>(run: (input: I) => Promise<O>, policy: ConcurrencyPolicy<I>): ((input: I) => Promise<O>) => {
    if (policy.mode === `parallel`) {
        return run;
    }
    const slots = new Map<string, Slot<I, O>>();
    const slotFor = (key: string): Slot<I, O> => {
        const existing = slots.get(key);
        if (existing !== undefined) {
            return existing;
        }
        const created: Slot<I, O> = {};
        slots.set(key, created);
        return created;
    };
    // An idle slot (nothing running, queued, or tailed) is garbage; dropped so a wrapper keyed by something unbounded
    // doesn't leak one map entry per key ever seen.
    const release = (key: string, slot: Slot<I, O>): void => {
        if (slot.inFlight === undefined && slot.queued === undefined && slot.tail === undefined) {
            slots.delete(key);
        }
    };

    if (policy.mode === `serial`) {
        return (input: I): Promise<O> => {
            const key = policy.key(input);
            const slot = slotFor(key);
            // An idle chain starts the command now, not on a microtask, so overlap policy adds no latency uncontended.
            const next = slot.tail === undefined ? run(input) : slot.tail.then(() => run(input));
            // The tail can never reject; a failed invocation must not unwind the separate commands queued behind it.
            const tail = next.then(
                () => undefined,
                () => undefined,
            );
            slot.tail = tail;
            void tail.then(() => {
                if (slot.tail === tail) {
                    slot.tail = undefined;
                    release(key, slot);
                }
            });
            return next;
        };
    }

    if (policy.mode === `singleFlight`) {
        return (input: I): Promise<O> => {
            const key = policy.key(input);
            const slot = slotFor(key);
            if (slot.inFlight !== undefined) {
                return slot.inFlight;
            }
            const started = run(input).finally(() => {
                slot.inFlight = undefined;
                release(key, slot);
            });
            slot.inFlight = started;
            return started;
        };
    }

    const start = (key: string, slot: Slot<I, O>, input: I): Promise<O> => {
        const started = run(input).finally(() => {
            slot.inFlight = undefined;
            drain(key, slot);
        });
        slot.inFlight = started;
        return started;
    };
    const drain = (key: string, slot: Slot<I, O>): void => {
        const queued = slot.queued;
        if (queued === undefined) {
            release(key, slot);
            return;
        }
        slot.queued = undefined;
        const started = start(key, slot, queued.input);
        for (const waiter of queued.waiters) {
            started.then(waiter.resolve, waiter.reject);
        }
    };
    return (input: I): Promise<O> => {
        const key = policy.key(input);
        const slot = slotFor(key);
        if (slot.inFlight === undefined) {
            return start(key, slot, input);
        }
        return new Promise<O>((resolve, reject) => {
            // Supersedes the queued value but inherits its waiters, so a dropped caller settles with the newer result.
            const waiters = slot.queued?.waiters ?? [];
            waiters.push({ resolve, reject });
            slot.queued = { input, waiters };
        });
    };
};
