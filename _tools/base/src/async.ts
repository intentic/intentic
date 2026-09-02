import type { IDisposable } from "./lifecycle.js";

/* THE FOUR SHAPES OF "DON'T DO THAT AGAIN YET", WRITTEN ONCE.
 *
 * These four existed eleven times between the daemon and the web, hand-rolled at each site out of a `let
 * timer` and a `setTimeout`, and the copies did not agree, which matters, because the difference between them
 * is not style. Two of the debouncers reset their clock on every event and two deliberately did not, and only
 * one of the four said which it was; a reader had to decide from `timer ??= setTimeout(…)` versus `timer =
 * setTimeout(…)`, one character apart, opposite behaviour, and the wrong one either drops the tail of a burst
 * or never fires at all while an agent keeps editing.
 *
 * Naming them separates that decision from the plumbing:
 *
 *   Delayer    , the clock restarts on every call. "Do it once the caller goes quiet." A search box.
 *   Coalescer  , the clock starts on the FIRST call of a window and later calls join it. "Do it at most every
 *                 N ms, with everything that arrived." A file watcher under a running agent, which never goes
 *                 quiet and so would starve a Delayer forever.
 *   SingleFlight- concurrent callers for the same key share one run. "Only one of these at a time; everybody
 *                 else waits for the answer that is already coming."
 *   retry      , the loop, with the delay in it.
 *
 * And, below them, the three primitives every reconnect loop, readiness wait and respawn ladder in the product
 * was hand-rolling beside its own copy of `setTimeout`-in-a-promise: `sleep`, `pollUntil` and `createBackoff`.
 *
 * All three classes are disposables, which is the other half of what the hand-rolled versions kept getting
 * wrong: a pending timer is a live handle, and every one of these sites had a teardown path that dropped it.
 */

/* Trailing debounce. Each `trigger` cancels the pending run and starts the wait over, so the task runs once,
 * `delay` after the last call, and the promise every caller in the window is holding resolves with that one
 * run's result. Superseded callers are not rejected: they asked for the effect, not for their own invocation,
 * and rejecting them turns "the user typed another character" into an unhandled rejection. */
export class Delayer<T> implements IDisposable {
    private handle: ReturnType<typeof setTimeout> | undefined;
    private pending:
        | { readonly promise: Promise<T>; readonly resolve: (value: T | PromiseLike<T>) => void; readonly reject: (error: unknown) => void }
        | undefined;
    private task: (() => T | Promise<T>) | undefined;

    constructor(private readonly delay: number) {}

    trigger(task: () => T | Promise<T>): Promise<T> {
        this.task = task;
        if (this.handle !== undefined) {
            clearTimeout(this.handle);
        }
        if (this.pending === undefined) {
            const { promise, resolve, reject } = Promise.withResolvers<T>();
            this.pending = { promise, resolve, reject };
        }
        const pending = this.pending;
        this.handle = setTimeout(() => {
            this.handle = undefined;
            this.pending = undefined;
            const run = this.task;
            this.task = undefined;
            if (run === undefined) {
                return;
            }
            try {
                pending.resolve(run());
            } catch (error) {
                pending.reject(error);
            }
        }, this.delay);
        return pending.promise;
    }

    get isPending(): boolean {
        return this.handle !== undefined;
    }

    /* Drops the pending run WITHOUT settling the promise its callers hold. That is deliberate: a cancel means
     * the effect is no longer wanted, and the callers are `void`-ing the promise for the effect. Settling it
     * with a value nobody computed would be a lie, and rejecting it would make every ordinary teardown produce
     * an unhandled rejection at every site that fired and forgot. */
    cancel(): void {
        if (this.handle !== undefined) {
            clearTimeout(this.handle);
            this.handle = undefined;
        }
        this.pending = undefined;
        this.task = undefined;
    }

    dispose(): void {
        this.cancel();
    }
}

/* Windowed batching. The first `add` of a window opens it and schedules the flush; everything arriving before
 * the flush joins the same batch and does NOT push the deadline out. This is the one a file watcher wants: an
 * agent editing continuously never produces a quiet moment, so a trailing debounce under it either never fires
 * or fires only when the agent stops, which is precisely when the browser no longer needs telling. */
export class Coalescer<T> implements IDisposable {
    private handle: ReturnType<typeof setTimeout> | undefined;
    private batch: T[] = [];

    constructor(
        private readonly window: number,
        private readonly flush: (batch: readonly T[]) => void,
    ) {}

    /* An arrow property, not a method, because this one is a SINK: callers hand `coalescer.add` straight to a
     * watcher, a worker port or a stream as the callback, and a plain method detached from its instance throws
     * on the first item. The rest of this file keeps ordinary methods, they are called on the object. */
    readonly add = (...items: readonly T[]): void => {
        this.batch.push(...items);
        this.handle ??= setTimeout(() => {
            this.handle = undefined;
            const batch = this.batch;
            this.batch = [];
            if (batch.length > 0) {
                this.flush(batch);
            }
        }, this.window);
    };

    get isPending(): boolean {
        return this.handle !== undefined;
    }

    // Emit what has accumulated right now and close the window. The one caller that needs this is a shutdown
    // that would otherwise drop a batch it already has.
    flushNow(): void {
        if (this.handle === undefined) {
            return;
        }
        clearTimeout(this.handle);
        this.handle = undefined;
        const batch = this.batch;
        this.batch = [];
        if (batch.length > 0) {
            this.flush(batch);
        }
    }

    dispose(): void {
        if (this.handle !== undefined) {
            clearTimeout(this.handle);
            this.handle = undefined;
        }
        this.batch = [];
    }
}

/* One run per key at a time, shared by everyone who asks while it is going. Not a queue: a second caller does
 * not get its own later run, it gets the answer from the run already in flight, which is the correct reading
 * for the two things in this daemon that need it. Refreshing an OAuth token is the sharp one, because a
 * *second* refresh of the same token is not merely wasteful: presenting a refresh token twice is what some
 * providers treat as theft and answer by revoking the grant.
 *
 * The key's entry is removed when the run settles, failure included, so a failed attempt is retried by the
 * next caller rather than being cached as a rejection forever. */
export class SingleFlight<K, T> implements IDisposable {
    private readonly running = new Map<K, Promise<T>>();

    run(key: K, task: () => Promise<T>): Promise<T> {
        const existing = this.running.get(key);
        if (existing !== undefined) {
            return existing;
        }
        const started = task().finally(() => {
            this.running.delete(key);
        });
        this.running.set(key, started);
        return started;
    }

    /* The run already in flight for this key, or undefined, for callers that want to WAIT for one if it is
     * happening but must not start one themselves. Token refresh needs exactly this: a reader that finds a
     * rotation under way has to let it land before reading the store, because the token sitting there is the
     * one that rotation is about to supersede, and handing it out would snapshot a doomed credential. */
    joined(key: K): Promise<T> | undefined {
        return this.running.get(key);
    }

    get size(): number {
        return this.running.size;
    }

    /* Forgets the tracking, which is all it can do, a promise cannot be cancelled. Runs already in flight
     * settle into nothing, which is right for teardown and is why this does not pretend to await them. */
    dispose(): void {
        this.running.clear();
    }
}

/* Attempt, wait, attempt again, and when the attempts run out, throw what the LAST one threw rather than a
 * summary of its own. The error a caller can act on is the provider's, not "retries exhausted". */
export const retry = async <T>(task: () => Promise<T>, delay: number, attempts: number): Promise<T> => {
    let last: unknown;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        try {
            // oxlint-disable-next-line eslint/no-await-in-loop -- sequential by definition; the whole point is to wait between attempts
            return await task();
        } catch (error) {
            last = error;
            if (attempt < attempts - 1) {
                // oxlint-disable-next-line eslint/no-await-in-loop -- the delay between attempts
                await sleep(delay);
            }
        }
    }
    throw last;
};

/* A promise that resolves after `ms`, and EARLY when the signal aborts, never rejecting: the loops that wait
 * this way read their own stop flag on the next line, so an aborted sleep simply ends the wait and the loop
 * sees why for itself. Rejecting would turn every ordinary teardown into a catch block at every call site.
 *
 * `unref` is for a daemon's own long waits (a tunnel's redial, a nudge's retry): a pending timer is a live
 * handle, and one that holds the process open past its shutdown is a leak with a stack trace nobody sees. It
 * is a no-op wherever the timer has no such handle (a browser). */
export const sleep = (ms: number, options?: { readonly signal?: AbortSignal | undefined; readonly unref?: boolean }): Promise<void> =>
    new Promise((resolve) => {
        const signal = options?.signal;
        if (signal?.aborted === true) {
            resolve();
            return;
        }
        const done = (): void => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", done);
            resolve();
        };
        const timer = setTimeout(done, ms);
        if (options?.unref === true) {
            (timer as { unref?: () => void }).unref?.();
        }
        signal?.addEventListener("abort", done, { once: true });
    });

/* Ask until it is true, or until the deadline. Always probes once BEFORE consulting the clock, so a wait is
 * never skipped by a deadline that has already passed, and answers whether the check passed rather than
 * throwing: what a miss MEANS ("dockerd did not come up", "the display never answered") belongs to the caller,
 * which is the one that can name it. A check that throws propagates: some waits (a process that already
 * exited) must fail fast rather than burn the whole deadline. An aborted signal ends the wait as a miss. */
export const pollUntil = async (
    check: () => boolean | Promise<boolean>,
    options: { readonly intervalMs: number; readonly timeoutMs: number; readonly signal?: AbortSignal | undefined },
): Promise<boolean> => {
    const deadline = Date.now() + options.timeoutMs;
    for (;;) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- polling is sequential by definition
        if (await check()) {
            return true;
        }
        if (Date.now() >= deadline || options.signal?.aborted === true) {
            return false;
        }
        // oxlint-disable-next-line eslint/no-await-in-loop -- the wait between probes
        await sleep(options.intervalMs, { signal: options.signal });
    }
};

export interface BackoffOptions {
    readonly floorMs: number;
    readonly capMs: number;
    /* A run that lasted at least this long was a WORKING one, and its failure restarts the ladder from the
     * floor. Without it a link that has been up for a week reconnects at the ceiling after one blip, because
     * the ladder still remembers a bad afternoon in between; with it, a dial that is refused on arrival keeps
     * climbing, which is what keeps a bad grant or a dead edge from being hammered. */
    readonly stableMs?: number;
    /* Full jitter: each wait is a random point between the floor and the rung it would otherwise be, so a
     * fleet that lost the same edge at the same instant does not reconvene on it at the same instant,
     * repeatedly. Injected rather than `Math.random` so a test can read the schedule off the ceiling. */
    readonly random?: () => number;
}

export interface Backoff {
    /* How long to wait before the next attempt, and the ladder climbs one rung for the time after that:
     * floor, 2×, 4×, … capped. `uptimeMs` is how long the attempt that just failed had been working, and at
     * or past `stableMs` it puts the ladder back on the floor first. */
    readonly next: (uptimeMs?: number) => number;
    // Back to the floor: the attempt succeeded outright (a health check passed, a poll answered).
    readonly reset: () => void;
}

/* THE EXPONENTIAL LADDER, written once. It existed fifteen times across the tunnel, the runner link, the
 * machine agent, the web extension, two process supervisors, two messaging connectors and four browser
 * streams, out of a `let delay` and a `Math.min(delay * 2, cap)`, and the copies did not agree on the two
 * things that decide whether a flapping link is a nuisance or an outage: whether a session that WORKED earns
 * the floor back (four did, five reset on any `open`, which lets a socket that opens and dies at once hammer
 * at the floor forever), and whether there is any jitter at all (one had it). */
export const createBackoff = ({ floorMs, capMs, stableMs, random }: BackoffOptions): Backoff => {
    let rung = floorMs;
    return {
        next: (uptimeMs) => {
            if (stableMs !== undefined && uptimeMs !== undefined && uptimeMs >= stableMs) {
                rung = floorMs;
            }
            const ceiling = Math.min(rung * 2, capMs);
            const wait = random === undefined ? rung : Math.round(floorMs + random() * (ceiling - floorMs));
            rung = ceiling;
            return wait;
        },
        reset: () => {
            rung = floorMs;
        },
    };
};
