import { errorMessage } from "./errors.js";
import type { IDisposable } from "./lifecycle.js";

// Delayer restarts on every call (a search box); Coalescer opens on the first call and holds the window (a watcher that
// never goes quiet); SingleFlight shares one run per key; retry loops with a delay. Plus sleep, pollUntil and
// createBackoff below. All are disposables: a pending timer is a live handle.

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

// Attempts, waits, attempts again; when attempts run out, throws the last attempt's own error, since that is what a
// caller can act on.
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
    // Full jitter: each wait lands randomly between floor and next rung; injectable so a test can fix the schedule.
    readonly random?: () => number;
}

export interface Backoff {
    // Next wait; the ladder climbs a rung after (floor, 2x, 4x... capped), unless `uptimeMs` is past `stableMs`.
    readonly next: (uptimeMs?: number) => number;
    // Back to the floor: the attempt succeeded outright (a health check passed, a poll answered).
    readonly reset: () => void;
}

// Exponential backoff ladder: a session that worked (past `stableMs`) earns the floor back on failure; one that dies
// immediately keeps climbing. Jitter is optional.
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
