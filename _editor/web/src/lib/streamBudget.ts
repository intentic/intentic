import type { EndpointKind } from "../client/endpoint/endpoint";

// Caps concurrent long-lived streams (`/events`, `/agent/attach`) per origin so they cannot exhaust the browser's
// 6-connection HTTP/1.1 limit and starve ordinary requests. Inert wherever the connection is known to multiplex (h2,
// h3); binds wherever it is known not to, and on a loopback route whose protocol is not known yet.

// HTTP/1.1's per-origin connection ceiling; not configurable.
const HTTP1_CONNECTIONS_PER_ORIGIN = 6;
// Connections reserved for ordinary requests, not spent on streams.
const RESERVED_FOR_REQUESTS = 2;

// The two kinds of long-lived stream, each its own pool rather than a shared queue: an unbounded `attach` must
// not starve the one `events` stream that keeps a window live.
export type StreamKind = `events` | `attach`;

const POOLS: Record<StreamKind, number> = {
    // Two windows' worth of `/events` permits; a third moves to the tunnel, or opens anyway where there is none.
    events: 2,
    // What remains after reserved requests and events permits.
    attach: HTTP1_CONNECTIONS_PER_ORIGIN - RESERVED_FOR_REQUESTS - 2,
};

// Time between checks for an alternate transport while a pool is full.
const OVERFLOW_MS = 5_000;

// A WebKit engine that isn't Blink: WebKitGTK (the Linux app) and Safari. Blink and Gecko reach the certified loopback
// name over h2.
const WEBKIT_ENGINE = ((agent: string): boolean => /AppleWebKit/.test(agent) && !/Chrome|Chromium|Edg\//.test(agent))(
    globalThis.navigator?.userAgent ?? ``,
);

// By what the browser negotiated, not by which address it dialled: the Linux app's WebKitGTK has spoken HTTP/1.1 to the
// certified loopback name, which every other browser reaches over h2. Unknown (no request answered yet, or a netd
// too old to send Timing-Allow-Origin, for good) is read by what the route and engine allow: plain-HTTP loopback is
// HTTP/1.1 in every browser, the certified loopback name is under a WebKit engine and multiplexed under the others,
// and the tunnel's edge serves h2 and h3 to everyone, which the phone and other browsers have always used uncapped.
export const streamCapacity = (kind: EndpointKind | undefined, protocol: string | undefined, webkit: boolean = WEBKIT_ENGINE): number => {
    const multiplexed =
        protocol === undefined
            ? kind === undefined || kind === `public` || (kind === `local` && !webkit)
            : protocol === `h2` || protocol.startsWith(`h3`);
    return multiplexed ? Number.POSITIVE_INFINITY : HTTP1_CONNECTIONS_PER_ORIGIN - RESERVED_FOR_REQUESTS;
};

// The protocol each origin's last timed response was carried over, from Resource Timing's `nextHopProtocol`; empty
// (a cross-origin response without Timing-Allow-Origin) says nothing and is skipped. Fed by an observer rather than
// read from the timeline, which stops recording at its 250-entry buffer within minutes of a busy window.
const protocols = new Map<string, string>();

export const recordProtocols = (entries: readonly Pick<PerformanceResourceTiming, `name` | `nextHopProtocol`>[]): void => {
    for (const entry of entries) {
        if (entry.nextHopProtocol === ``) {
            continue;
        }
        try {
            protocols.set(new URL(entry.name).origin, entry.nextHopProtocol);
            // allow(silent-catch): an entry without a URL for a name cannot say anything about an origin.
        } catch {
            continue;
        }
    }
};

if (`PerformanceObserver` in globalThis && PerformanceObserver.supportedEntryTypes?.includes(`resource`) === true) {
    new PerformanceObserver((list) => {
        // SAFETY: an observer of type `resource` is handed PerformanceResourceTiming entries and nothing else.
        recordProtocols(list.getEntriesByType(`resource`) as PerformanceResourceTiming[]);
    }).observe({ type: `resource`, buffered: true });
}

// What the browser negotiated with `base`'s origin, or undefined until a timed response from it has been seen.
export const measuredProtocol = (base: string | undefined): string | undefined => {
    if (base === undefined) {
        return undefined;
    }
    try {
        return protocols.get(new URL(base).origin);
        // allow(silent-catch): a malformed endpoint is unknown, which keeps the HTTP/1.1 reserve on loopback.
    } catch {
        return undefined;
    }
};

// Permits for one stream kind on one transport; unbounded transports return unbounded for every pool.
export const streamPermits = (kind: EndpointKind | undefined, protocol: string | undefined, stream: StreamKind): number =>
    streamCapacity(kind, protocol) === Number.POSITIVE_INFINITY ? Number.POSITIVE_INFINITY : POOLS[stream];

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

// Called when a window can't be admitted. True means the caller moved to an alternate transport.
let overflow: () => boolean = () => false;

export const setStreamOverflow = (onOverflow: () => boolean): void => {
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
const takePermit = async (stream: StreamKind, signal: AbortSignal | undefined): Promise<(() => void) | undefined> => {
    for (;;) {
        const permits = permitsOf(stream);
        if (permits === Number.POSITIVE_INFINITY) {
            return () => undefined;
        }
        const names = Array.from({ length: permits }, (_, index) => `intentic.stream.${scopeOf()}.${stream}.${index}`);
        const release =
            globalThis.navigator?.locks === undefined ? await takeCounter(stream, signal, OVERFLOW_MS) : await takeLock(names, signal, OVERFLOW_MS);
        if (release !== undefined) {
            return once(release);
        }
        if (aborted(signal)) {
            return undefined;
        }
        // A loopback route can hand new callers to the tunnel. With nowhere to go, an attach keeps waiting: opening
        // on HTTP/1.1 past a full pool spends the connections kept for permission answers and sends. A window's one
        // `/events` still opens, since without it the window never goes live at all.
        if (overflow() || stream === `events`) {
            return () => undefined;
        }
    }
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
    return takePermit(stream, signal);
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
    overflow = () => false;
    protocols.clear();
};
