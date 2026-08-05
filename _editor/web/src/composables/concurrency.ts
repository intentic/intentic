/* What happens when the same command is invoked again while it is still running — as a policy you pick, not
 * something each call site reinvents.
 *
 * Every one of these had a hand-rolled instance somewhere: a provider catalog load that deduped by checking
 * whether its own UI state ref said "loading" (a mutex made of presentation state), a forced sandbox-list
 * refresh three unrelated callers can fire at once, a search that races its own keystrokes. They are the same
 * four behaviours, and naming them is what makes a call site's intent reviewable — `singleFlight` says "one is
 * enough", `latest` says "only the newest input matters", and the difference between them is exactly the bug
 * class where a stale response overwrites a fresh one.
 *
 * Keyed policies scope the rule to a resource: two providers' catalogs load concurrently, but two loads of the
 * SAME provider's catalog collapse. */

export type ConcurrencyPolicy<I> =
    // Every invocation runs independently — the default behaviour of a bare async function.
    | { readonly mode: "parallel" }
    // FIFO per key: every invocation runs, but never two at once and never out of order.
    | { readonly mode: "serial"; readonly key: (input: I) => string }
    // An invocation arriving while one is in flight SHARES it — same promise, one request. For idempotent
    // reads where a second answer would be identical anyway.
    | { readonly mode: "singleFlight"; readonly key: (input: I) => string }
    // At most one running and one queued per key; a new invocation REPLACES whatever was queued. Callers whose
    // input was superseded settle with the result of the run that superseded them, so nobody hangs.
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
    // A slot with nothing running and nothing queued is garbage. Dropped so a wrapper keyed by something
    // unbounded (a file path, a session id) doesn't grow one map entry per key it has ever seen.
    const release = (key: string, slot: Slot<I, O>): void => {
        if (slot.inFlight === undefined && slot.queued === undefined && slot.tail === undefined) {
            slots.delete(key);
        }
    };

    if (policy.mode === `serial`) {
        return (input: I): Promise<O> => {
            const key = policy.key(input);
            const slot = slotFor(key);
            // An idle chain starts the command NOW rather than a microtask later: a policy about overlap must
            // not add latency to the uncontended case, which is nearly all of them.
            const next = slot.tail === undefined ? run(input) : slot.tail.then(() => run(input));
            // The chain is tracked by a tail that CANNOT reject: a failed invocation must not unwind the ones
            // queued behind it (they are separate commands, not steps of one).
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
            // Supersede whatever was queued — its input is stale by definition — but INHERIT its waiters, so a
            // caller whose input was dropped still settles, with the newer run's result.
            const waiters = slot.queued?.waiters ?? [];
            waiters.push({ resolve, reject });
            slot.queued = { input, waiters };
        });
    };
};
