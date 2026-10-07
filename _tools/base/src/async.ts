import { errorMessage } from "./errors.js";
import type { IDisposable } from "./lifecycle.js";

// Delayer restarts on every call (a search box); Coalescer opens on the first call and holds the window (a watcher that
// never goes quiet); SingleFlight shares one run per key; keyedLock queues them. Plus sleep, withTimeout, pollUntil
// and createBackoff below. All are disposables: a pending timer is a live handle.
//
// Cancellation is an AbortSignal throughout, never a flag or a counter compared after an await: Latest hands each new
// attempt a signal and aborts the one before it, anySignal links a caller's signal into one of your own, retry and
// pollFor stop waiting the moment theirs aborts, and withDeadline tells the work to stop when its time is up rather
// than only ceasing to wait for it. `within` and `unlessAborted` are the soft waits: they stop waiting (at a time, at
// an abort) and leave the work running.

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
            // Only its own entry: a run started after a dispose holds the key now, and must stay joinable.
            if (this.running.get(key) === started) {
                this.running.delete(key);
            }
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

// Raised by withDeadline when the time runs out, and handed to the work as its signal's reason, so a catch can tell a
// deadline from a stop or a failure of the work's own.
export class TimeoutError extends Error {
    override readonly name = `TimeoutError`;
}

// Runs `task` with a signal that aborts when `ms` pass or the caller's own signal aborts, and rejects at that moment
// even if the task ignores its signal. Unlike withTimeout, the work is told to stop (a fetch is cancelled, a stream
// closed), not just no longer waited for. Rejects with a TimeoutError at the deadline, with the caller's abort reason
// on a stop.
export const withDeadline = async <T>(
    task: (signal: AbortSignal) => Promise<T>,
    ms: number,
    options?: { readonly signal?: AbortSignal | undefined; readonly message?: string },
): Promise<T> => {
    const deadline = new AbortController();
    const signal = anySignal(deadline.signal, options?.signal);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe = (): void => {};
    const cut = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
            const error = new TimeoutError(options?.message ?? `timed out after ${ms}ms`);
            deadline.abort(error);
            reject(error);
        }, ms);
        unsubscribe = whenAborted(options?.signal, () => reject(options?.signal?.reason));
    });
    try {
        return await Promise.race([task(signal), cut]);
    } finally {
        clearTimeout(timer);
        unsubscribe();
    }
};

// What `promise` settles to, or `fallback` once `ms` pass first; the timer is cleared however it ends. The work goes on
// regardless: this is for a wait that may give up on an answer it can live without (a best-effort read, a close that
// may never come), never for stopping anything. Stopping is withDeadline's.
export const within = async <T, F>(promise: Promise<T>, ms: number, fallback: F): Promise<T | F> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<F>((resolve) => {
                timer = setTimeout(() => resolve(fallback), ms);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
};

// What `promise` settles to, or `fallback` the moment `signal` aborts first (at once if it already has); the listener
// goes however the race ends. A loop that races each read against one long-lived promise instead (a grace that has not
// started) leaves a reaction on it per read, and every value it raced stays reachable until that promise settles: a
// turn's every frame, for a turn that is never stopped. The work goes on regardless, as with `within`.
export const unlessAborted = async <T, F>(promise: Promise<T>, signal: AbortSignal | undefined, fallback: F): Promise<T | F> => {
    if (signal === undefined) {
        return promise;
    }
    let unsubscribe = (): void => {};
    try {
        return await Promise.race([
            promise,
            new Promise<F>((resolve) => {
                unsubscribe = whenAborted(signal, () => resolve(fallback));
            }),
        ]);
    } finally {
        unsubscribe();
    }
};

// Every signal given, as one: aborts when the first of them does, with its reason. Undefined entries are skipped, so an
// optional caller signal links without a branch, and the native link (AbortSignal.any) leaves no listener behind on a
// long-lived parent, which a hand-written addEventListener does.
export const anySignal = (...signals: readonly (AbortSignal | undefined)[]): AbortSignal => {
    const present = signals.filter((signal): signal is AbortSignal => signal !== undefined);
    const [only] = present;
    return present.length === 1 && only !== undefined ? only : AbortSignal.any(present);
};

// One attempt at a time: `next()` aborts the attempt before it and hands the new one its own signal, so a superseded
// attempt is stopped (its fetch cancelled, its poll ended) rather than left to finish and be ignored by a counter
// compared after every await. `isCurrent` is that comparison when a step cannot take a signal; `done` forgets an
// attempt that finished without aborting it, and leaves a newer one alone (what a `finally` wants).
export class Latest implements IDisposable {
    private controller: AbortController | undefined;
    private signal: AbortSignal | undefined;

    // Aborts the attempt in flight, if any, and starts the next. Its signal also aborts with `parent`.
    next(parent?: AbortSignal): AbortSignal {
        this.abort();
        const controller = new AbortController();
        const signal = anySignal(controller.signal, parent);
        this.controller = controller;
        this.signal = signal;
        return signal;
    }

    // The attempt running now, if one is.
    get current(): AbortSignal | undefined {
        return this.signal;
    }

    // Whether `signal` is still the running attempt: not superseded, not aborted, not done.
    isCurrent(signal: AbortSignal): boolean {
        return signal === this.signal && !signal.aborted;
    }

    // Stops the attempt in flight without starting another.
    abort(): void {
        const controller = this.controller;
        this.controller = undefined;
        this.signal = undefined;
        controller?.abort();
    }

    // The attempt behind `signal` has finished: it stops being current, and is not aborted. A newer one is untouched.
    done(signal: AbortSignal): void {
        if (signal === this.signal) {
            this.controller = undefined;
            this.signal = undefined;
        }
    }

    dispose(): void {
        this.abort();
    }
}

export interface RetryOptions {
    // Tries in all, the first included; Infinity for a loop only the signal ends.
    readonly attempts: number;
    // The wait after try `attempt` (1-based) fails: `() => 500` for a fixed one, `() => ladder.next()` to draw from a
    // backoff ladder. A failure that is an answer rather than a blip (a refusal) should not be thrown at all: return it.
    readonly delayMs: (attempt: number) => number;
    readonly signal?: AbortSignal | undefined;
}

// Read through a call, so a check after an await is not narrowed away by the same check before it.
const isAborted = (signal: AbortSignal | undefined): boolean => signal?.aborted === true;

// Runs `task` until it resolves, rethrowing the last failure when the tries run out or the signal aborted during the
// try. A stop during the wait after one cuts it short and rejects with the signal's reason, as an aborted fetch does,
// so a caller telling a stop from a failure (an AbortError) reads both the same way.
// `task` gets the attempt number, and is expected to hand the same signal to whatever it calls.
export const retry = async <T>(task: (attempt: number) => Promise<T>, options: RetryOptions): Promise<T> => {
    const { signal } = options;
    for (let attempt = 1; ; attempt += 1) {
        try {
            // oxlint-disable-next-line eslint/no-await-in-loop -- tries are sequential by definition
            return await task(attempt);
        } catch (error) {
            if (attempt >= options.attempts || isAborted(signal)) {
                throw error;
            }
            // oxlint-disable-next-line eslint/no-await-in-loop -- the wait between tries
            await sleep(options.delayMs(attempt), { signal });
            if (signal !== undefined && isAborted(signal)) {
                // oxlint-disable-next-line typescript/only-throw-error -- the abort's own reason, as fetch rejects with it
                throw signal.reason;
            }
        }
    }
};

export type PollOutcome<T> = { readonly kind: `found`; readonly value: T } | { readonly kind: `expired` } | { readonly kind: `aborted` };

export interface PollForOptions {
    readonly intervalMs: number;
    // Epoch ms the poll gives up at. The last wait is cut short to land on it, so expiry is said at the deadline, not on
    // the first tick after it.
    readonly until: number;
    readonly signal?: AbortSignal | undefined;
    // Wait one interval before the first probe (something nobody can have finished yet); otherwise the first probe is now.
    readonly delayFirst?: boolean;
    // A probe that throws is a blip, probed again next interval (a sign-in's status read across a network hiccup).
    // Otherwise a throw propagates.
    readonly retryOnError?: boolean;
    readonly now?: (() => number) | undefined;
}

// Probes until one answers with a value (undefined: not yet), the deadline passes, or the signal aborts. A probe that
// answers after its poll was aborted speaks for nobody: the outcome is `aborted`, so a superseded attempt cannot act on
// what it read. One that answers after the deadline but before an abort still counts: what it found did land.
export const pollFor = async <T>(probe: () => Promise<T | undefined>, options: PollForOptions): Promise<PollOutcome<T>> => {
    const now = options.now ?? Date.now;
    const { signal } = options;
    const wait = (): Promise<void> => sleep(Math.max(0, Math.min(options.intervalMs, options.until - now())), { signal });
    if (options.delayFirst === true) {
        await wait();
    }
    for (;;) {
        if (isAborted(signal)) {
            return { kind: `aborted` };
        }
        if (now() >= options.until) {
            return { kind: `expired` };
        }
        let value: T | undefined;
        try {
            // oxlint-disable-next-line eslint/no-await-in-loop -- polling is sequential by definition
            value = await probe();
        } catch (error) {
            if (options.retryOnError !== true) {
                throw error;
            }
        }
        if (isAborted(signal)) {
            return { kind: `aborted` };
        }
        if (value !== undefined) {
            return { kind: `found`, value };
        }
        // oxlint-disable-next-line eslint/no-await-in-loop -- the wait between probes
        await wait();
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
        async *drain() {
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
