import { errorMessage } from "./errors.js";
import type { IDisposable } from "./lifecycle.js";

// Delayer restarts on every call (a search box); Coalescer opens on the first call and holds the window (a watcher that
// never goes quiet); SingleFlight shares one run per key; keyedLock queues them. Plus sleep, withTimeout, pollUntil
// and createBackoff below. All are disposables: a pending timer is a live handle.

// Trailing debounce: `trigger` restarts the wait, so the task runs once, `delay` after the last call; every caller in
// the window shares that result. Superseded callers are not rejected, only the effect was requested.
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

    // Drops the pending run without settling its promise: callers `void` it for the effect, so resolving with nothing
    // or rejecting would both be wrong.
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

// Windowed batching: the first `add` opens the window and schedules the flush; later calls join it without pushing the
// deadline out. For a source that never goes quiet (a file watcher under a live agent).
export class Coalescer<T> implements IDisposable {
    private handle: ReturnType<typeof setTimeout> | undefined;
    private batch: T[] = [];

    constructor(
        private readonly window: number,
        private readonly flush: (batch: readonly T[]) => void,
    ) {}

    // Arrow property, not a method: callers hand `coalescer.add` directly to a watcher or stream as a callback, and a
    // detached method would lose its `this`.
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

    // Emits what has accumulated and closes the window now, for a shutdown that would otherwise drop a pending batch.
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

// One run per key, shared by every concurrent caller; not a queue, so a second caller gets the run already in flight.
// The key's entry is removed when the run settles, so a failure is retried, not cached.
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

    // The run already in flight for a key, or undefined, for a caller that must wait for one without starting one
    // itself.
    joined(key: K): Promise<T> | undefined {
        return this.running.get(key);
    }

    get size(): number {
        return this.running.size;
    }

    // Forgets the tracking; a promise cannot be cancelled, so runs already in flight settle into nothing, unawaited.
    dispose(): void {
        this.running.clear();
    }
}

// One run at a time per key, each after the last however it ended; a key is forgotten once its queue drains.
export const keyedLock = <K>(): (<T>(key: K, task: () => Promise<T>) => Promise<T>) => {
    const tails = new Map<K, Promise<unknown>>();
    return (key, task) => {
        const next = (tails.get(key) ?? Promise.resolve()).then(task, task);
        const tail = next.catch(() => undefined);
        tails.set(key, tail);
        void tail.then(() => {
            if (tails.get(key) === tail) {
                tails.delete(key);
            }
        });
        return next;
    };
};

// One run at a time, each after the last however it ended: a keyedLock with one key.
export const serialLock = (): (<T>(task: () => Promise<T>) => Promise<T>) => {
    const lock = keyedLock<undefined>();
    return (task) => lock(undefined, task);
};

// Runs `task` over every item with at most `limit` in flight, in item order. Rejects with the first rejection, after
// the workers already started have settled; a task that must not lose its siblings' results catches its own.
export const mapPool = async <T>(items: readonly T[], limit: number, task: (item: T) => Promise<void>): Promise<void> => {
    let next = 0;
    const worker = async (): Promise<void> => {
        for (let item = items[next++]; item !== undefined; item = items[next++]) {
            // oxlint-disable-next-line eslint/no-await-in-loop -- one worker is sequential by definition; `limit` of them run at once
            await task(item);
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
};

// Resolves after `ms`, and early, never rejecting, if the signal aborts, so a loop reading its own stop flag next just
// ends. `unref` keeps a daemon's long waits from holding the process open; a no-op where there is no such handle.
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

// Rejects with `message` when `promise` has not settled within `ms`. The timer is cleared however the race ends, so a
// walk wrapping thousands of reads leaks none; the promise itself keeps running, since giving up on an answer cancels
// nothing.
export const withTimeout = async <T>(promise: Promise<T>, ms: number, message = `timed out after ${ms}ms`): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error(message)), ms);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
};

export interface PollOptions {
    readonly intervalMs: number;
    readonly timeoutMs: number;
    readonly signal?: AbortSignal | undefined;
    // Runs only when another probe is coming, so a narrated wait says nothing extra on the attempt that gave up.
    readonly onRetry?: (() => void) | undefined;
    // Injectable clock pair, both or neither: a fake `now` with real `sleep` spins; `wait` still respects `signal`.
    readonly now?: (() => number) | undefined;
    readonly wait?: ((ms: number) => Promise<void>) | undefined;
}

// Probe, give up at a deadline, sleep between tries; probes once before checking the clock, so a passed deadline never
// skips a wait. Returns false on a miss or abort; a throwing check propagates.
export const pollUntil = async (check: () => boolean | Promise<boolean>, options: PollOptions): Promise<boolean> => {
    const now = options.now ?? Date.now;
    const wait = options.wait ?? ((ms: number) => sleep(ms, { signal: options.signal }));
    const deadline = now() + options.timeoutMs;
    for (;;) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- polling is sequential by definition
        if (await check()) {
            return true;
        }
        if (now() >= deadline || options.signal?.aborted === true) {
            return false;
        }
        options.onRetry?.();
        // oxlint-disable-next-line eslint/no-await-in-loop -- the wait between probes
        await wait(options.intervalMs);
    }
};

export interface BackoffOptions {
    readonly floorMs: number;
    readonly capMs: number;
    // A run at least this long resets the ladder to the floor on failure; a short run keeps climbing.
    readonly stableMs?: number;
    // Full jitter: each wait lands randomly between floor and next rung. Defaults to Math.random; injectable so a test
    // can fix the schedule.
    readonly random?: () => number;
}

export interface Backoff {
    // Next wait, drawn between the floor and this rung's ceiling (2x, 4x... capped); the ceiling climbs after each call
    // unless `uptimeMs` is past `stableMs`.
    readonly next: (uptimeMs?: number) => number;
    // Back to the floor: the attempt succeeded outright (a health check passed, a poll answered).
    readonly reset: () => void;
}

// Exponential backoff ladder: a session that worked (past `stableMs`) earns the floor back on failure; one that dies
// immediately keeps climbing. Always jittered, like the relay's Rust twin (`_shared/relay/src/backoff.rs`): every
// client of one daemon drops at the same instant when it restarts, and a fixed schedule would bring them all back on
// the same tick.
export const createBackoff = ({ floorMs, capMs, stableMs, random = Math.random }: BackoffOptions): Backoff => {
    let rung = floorMs;
    return {
        next: (uptimeMs) => {
            if (stableMs !== undefined && uptimeMs !== undefined && uptimeMs >= stableMs) {
                rung = floorMs;
            }
            const ceiling = Math.min(rung * 2, capMs);
            rung = ceiling;
            return Math.round(floorMs + random() * (ceiling - floorMs));
        },
        reset: () => {
            rung = floorMs;
        },
    };
};

export interface NarratedLine {
    readonly kind: "line";
    readonly text: string;
}

// Turns a callback-reporting operation (`onLine`) into a stream: lines are queued, not dropped, when the consumer is
// slower. A failure is the stream's terminal frame, not a thrown rejection, via `end`.
export async function* narrate<Value, Frame>(
    run: (onLine: (line: string) => void) => Promise<Value>,
    end: (outcome: { readonly ok: true; readonly value: Value } | { readonly ok: false; readonly error: string }) => Frame,
): AsyncGenerator<NarratedLine | Frame> {
    const queued: string[] = [];
    let wake: (() => void) | undefined;
    const nudge = (): void => {
        const pending = wake;
        wake = undefined;
        pending?.();
    };
    let settled: { readonly ok: true; readonly value: Value } | { readonly ok: false; readonly error: string } | undefined;
    const finished = run((line) => {
        queued.push(line);
        nudge();
    })
        .then((value) => ({ ok: true, value }) as const)
        .catch((error: unknown) => ({ ok: false, error: errorMessage(error) }) as const)
        .then((outcome) => {
            settled = outcome;
            nudge();
        });

    for (;;) {
        const next = queued.shift();
        if (next !== undefined) {
            yield { kind: "line", text: next };
            continue;
        }
        // Drained AND finished: every line the run produced has been sent, so the terminal frame is next.
        if (settled !== undefined) {
            break;
        }
        await new Promise<void>((resolve) => {
            wake = resolve;
        });
    }
    await finished;
    yield end(settled);
}

// An already-aborted signal never fires `addEventListener('abort', …)` (events aren't replayed); this runs the handler
// synchronously instead and returns an always-safe unregister function.
export const whenAborted = (signal: AbortSignal | undefined, handler: () => void): (() => void) => {
    if (signal === undefined) {
        return (): void => {};
    }
    if (signal.aborted) {
        handler();
        return (): void => {};
    }
    signal.addEventListener("abort", handler, { once: true });
    return (): void => signal.removeEventListener("abort", handler);
};

export interface WatchOptions {
    readonly signal?: AbortSignal | undefined;
    // Epoch ms the watch ends by itself, even if nobody aborts it.
    readonly until: number;
    // However far away `until` is, the watch never outlives this many ms from when its reader starts: a forgotten one
    // must not hold what it watches (a port, a tab listener) for as long as a caller happened to ask.
    readonly longestMs: number;
    readonly now?: () => number;
}

export interface WatchQueue<T> {
    // Hands a value to the reader; queued, in order, however slow the reader is.
    readonly push: (value: T) => void;
    // Every value pushed, until the signal aborts or the deadline passes; whatever was pushed before that is still
    // yielded first. One reader.
    readonly drain: () => AsyncGenerator<T>;
}

// Turns a watch that reports through callbacks (an HTTP listener, a browser event) into a stream with a deadline, the
// shape both loopback-catch peers answer with.
export const watchQueue = <T>({ signal, until, longestMs, now = Date.now }: WatchOptions): WatchQueue<T> => {
    const queue: T[] = [];
    let wake: (() => void) | undefined;
    let over = false;
    const nudge = (): void => {
        const resume = wake;
        wake = undefined;
        resume?.();
    };
    const end = (): void => {
        over = true;
        nudge();
    };
    return {
        push: (value) => {
            queue.push(value);
            nudge();
        },
        drain: async function* () {
            const deadline = setTimeout(end, Math.max(0, Math.min(until - now(), longestMs)));
            const unsubscribe = whenAborted(signal, end);
            try {
                for (;;) {
                    if (queue.length > 0) {
                        yield queue.shift() as T;
                        continue;
                    }
                    if (over) {
                        break;
                    }
                    await new Promise<void>((resolve) => (wake = resolve));
                }
            } finally {
                clearTimeout(deadline);
                unsubscribe();
            }
        },
    };
};
