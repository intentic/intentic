import type { EndpointKind } from "../secrets/endpoint";

// Caps concurrent long-lived streams (`/events`, `/agent/attach`) per origin so they cannot exhaust the browser's
// 6-connection HTTP/1.1 limit and starve ordinary requests. Inert wherever h2/h3 multiplexes; binds only on the
// plain HTTP loopback transport.

// HTTP/1.1's per-origin connection ceiling; not configurable.
const HTTP1_CONNECTIONS_PER_ORIGIN = 6;
// Connections reserved for ordinary requests, not spent on streams.
const RESERVED_FOR_REQUESTS = 2;

// The two kinds of long-lived stream, each its own pool rather than a shared queue: an unbounded `attach` must
// not starve the one `events` stream that keeps a window live.
export type StreamKind = `events` | `attach`;

const POOLS: Record<StreamKind, number> = {
    // Two windows' worth of `/events` permits; a third overflows to the tunnel.
    events: 2,
    // What remains after reserved requests and events permits.
    attach: HTTP1_CONNECTIONS_PER_ORIGIN - RESERVED_FOR_REQUESTS - 2,
};

// Max wait before an acquire gives up on this transport and reports overflow.
const OVERFLOW_MS = 5_000;

export const streamCapacity = (kind: EndpointKind | undefined): number =>
    kind === `local-insecure` ? HTTP1_CONNECTIONS_PER_ORIGIN - RESERVED_FOR_REQUESTS : Number.POSITIVE_INFINITY;

// Permits for one stream kind on one transport; unbounded transports return unbounded for every pool.
export const streamPermits = (endpoint: EndpointKind | undefined, stream: StreamKind): number =>
    streamCapacity(endpoint) === Number.POSITIVE_INFINITY ? Number.POSITIVE_INFINITY : POOLS[stream];

// Re-read on every acquire/release, not snapshotted: the endpoint can change under a running stream.
let permitsOf: (stream: StreamKind) => number = () => Number.POSITIVE_INFINITY;

export const setStreamCapacity = (read: (stream: StreamKind) => number): void => {
    permitsOf = read;
};

// Lock names must include the daemon origin so two sandboxes' pools of six stay independent.
let scopeOf: () => string = () => `default`;

export const setStreamScope = (read: () => string): void => {
    scopeOf = read;
};

// Called when a window can't be admitted, to leave this transport. Unset in tests and on unbounded paths.
let overflow: () => void = () => undefined;

export const setStreamOverflow = (onOverflow: () => void): void => {
    overflow = onOverflow;
};

// Cross-window pool: races one named Web Lock per permit, first grant wins and cancels the rest. A dead
// window's locks release automatically.
const takeLock = (names: readonly string[], signal: AbortSignal | undefined, timeoutMs: number): Promise<(() => void) | undefined> =>
    new Promise<(() => void) | undefined>((resolveOuter) => {
        const race = new AbortController();
        let release: () => void = () => undefined;
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        let settled = false;
        const finish = (value: (() => void) | undefined): void => {
            if (settled) {
                return;
            }
            settled = true;
            resolveOuter(value);
        };
        const standDown = (): void => {
            race.abort();
            finish(undefined);
        };
        signal?.addEventListener(`abort`, standDown, { once: true });
        // Overflow deadline; cleared on every exit path so it cannot outlive this acquire.
        const timer = setTimeout(standDown, timeoutMs);
        let pending = names.length;
        for (const name of names) {
            void navigator.locks
                .request(name, { signal: race.signal }, async () => {
                    // Caller already gave up when this lock granted: return without holding it.
                    if (settled) {
                        return;
                    }
                    clearTimeout(timer);
                    // Cancels only the sibling waits; this lock is already granted.
                    race.abort();
                    finish(release);
                    return held;
                })
                .catch(() => {
                    pending -= 1;
                    // All names refused; ignored once one was granted, whose own abort caused these rejections.
                    if (pending === 0) {
                        clearTimeout(timer);
                        finish(undefined);
                    }
                });
        }
    });

// Single-realm fallback for a browser or test without Web Locks: an in-memory counter, exact when there is
// only one realm to coordinate with.
const held: Record<StreamKind, number> = { events: 0, attach: 0 };
const waiting: Record<StreamKind, ((granted: boolean) => void)[]> = { events: [], attach: [] };

// FIFO, matching Web Locks' own order so both primitives behave alike.
const pump = (stream: StreamKind): void => {
    while (waiting[stream].length > 0 && held[stream] < permitsOf(stream)) {
        held[stream] += 1;
        waiting[stream].shift()?.(true);
    }
};

// Same contract as `takeLock`: a release, or undefined for not-granted (abort or deadline). Callers re-read
// the signal to tell which.
const takeCounter = async (stream: StreamKind, signal: AbortSignal | undefined, timeoutMs: number): Promise<(() => void) | undefined> => {
    if (held[stream] < permitsOf(stream)) {
        held[stream] += 1;
    } else {
        // Declared here so it can be cleared however the wait settles, including a wake via `pump`.
        let timer: ReturnType<typeof setTimeout> | undefined;
        const queued = await new Promise<boolean>((resolve) => {
            // `held` is incremented by pump before this waiter resumes, so its slot can't be taken twice.
            const wake = resolve;
            waiting[stream].push(wake);
            const standDown = (): void => {
                const at = waiting[stream].indexOf(wake);
                if (at === -1) {
                    // Already woken and counted: resolve as held so the release below runs.
                    resolve(true);
                    return;
                }
                waiting[stream].splice(at, 1);
                resolve(false);
            };
            timer = setTimeout(standDown, timeoutMs);
            signal?.addEventListener(`abort`, standDown, { once: true });
        });
        clearTimeout(timer);
        if (!queued) {
            return undefined;
        }
    }
    return (): void => {
        held[stream] -= 1;
        pump(stream);
    };
};

// Runs the release exactly once no matter how often it's called; a double release would admit two streams
// past one permit.
const once = (release: () => void): (() => void) => {
    let released = false;
    return (): void => {
        if (released) {
            return;
        }
        released = true;
        release();
    };
};

// Reads the signal fresh each call rather than a value captured before an await.
const aborted = (signal: AbortSignal | undefined): boolean => signal?.aborted === true;

// Takes a permit from whichever primitive the browser provides and resolves what a refusal means; the policy
// is written once here for both.
const takePermit = async (stream: StreamKind, permits: number, signal: AbortSignal | undefined): Promise<(() => void) | undefined> => {
    const names = Array.from({ length: permits }, (_, index) => `intentic.stream.${scopeOf()}.${stream}.${index}`);
    const release =
        globalThis.navigator?.locks === undefined ? await takeCounter(stream, signal, OVERFLOW_MS) : await takeLock(names, signal, OVERFLOW_MS);
    if (release !== undefined) {
        return once(release);
    }
    if (aborted(signal)) {
        return undefined;
    }
    // All permits exhausted: report overflow and open anyway rather than block or refuse.
    overflow();
    return () => undefined;
};

// Acquires a permit for one long-lived stream; call the release when the stream ends. A caller with a signal
// must re-check it after awaiting: an abort landing in that gap is not covered here.
export const acquireStreamSlot = async (stream: StreamKind = `attach`, signal?: AbortSignal): Promise<(() => void) | undefined> => {
    // An already-aborted signal never fires again; a caller that queued on one would wait forever.
    if (aborted(signal)) {
        return undefined;
    }
    const permits = permitsOf(stream);
    if (permits === Number.POSITIVE_INFINITY) {
        return () => undefined;
    }
    return takePermit(stream, permits, signal);
};

// Test seam: resets state and moves the lock names to a fresh scope, since Web Locks belong to the browser or
// process and cannot be reset directly.
let resets = 0;

export const resetStreamBudget = (): void => {
    held.events = 0;
    held.attach = 0;
    waiting.events.length = 0;
    waiting.attach.length = 0;
    permitsOf = () => Number.POSITIVE_INFINITY;
    resets += 1;
    const scope = `reset-${resets}`;
    scopeOf = () => scope;
    overflow = () => undefined;
};
