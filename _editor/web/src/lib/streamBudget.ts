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

// How often a stream somebody is watching, waiting on a full pool, looks for one nobody is watching to take the permit
// of. A free permit is granted at once, so the first look never kicks a stream that a free permit would have spared.
const HANDOFF_MS = 500;

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

/* WHO A FULL POOL SERVES FIRST. Permits went first come, first served, so a chat open in a tab nobody shows could hold
   one for its whole turn while the chat on screen waited behind it with no end: on plain-HTTP loopback (two attach
   permits, nowhere to overflow to) a new agent drew its prompt and a working line for five minutes, never a row, and its
   question only by a reload (2026-11-22). A stream that says whether it is watched (a claim) is served by that: one
   that is takes the permit of one that is not, which closes and asks again, catching up whole from its next head. */

/** What a stream says of itself when it asks for a permit; a stream that says nothing never yields and never takes. */
export interface StreamClaim {
    // Whether somebody is looking at what it carries now; read whenever a permit is contested, since that moves.
    readonly wanted: () => boolean;
    // Its permit went to a stream somebody is watching: the caller closes its connection and asks again. Its own release
    // frees nothing by then, since the permit is the other stream's.
    readonly giveUp: () => void;
}

// A permit this window holds for a stream that made a claim, kept findable so a watched stream can take it over.
interface Holding {
    readonly stream: StreamKind;
    readonly scope: string;
    readonly claim: StreamClaim;
    // The permit's own release; undefined once released or handed over.
    release: (() => void) | undefined;
}

// This window's only: another window's permits are its Web Locks, which nothing here can hand over.
const holdings = new Set<Holding>();

// The caller's release for a permit it now holds: findable while held if it made a claim, released exactly once.
const holding = (stream: StreamKind, scope: string, release: () => void, claim: StreamClaim | undefined): (() => void) => {
    if (claim === undefined) {
        return once(release);
    }
    const kept: Holding = { stream, scope, claim, release };
    holdings.add(kept);
    return (): void => {
        holdings.delete(kept);
        const own = kept.release;
        kept.release = undefined;
        own?.();
    };
};

// Takes the permit of a stream of this kind and scope nobody is watching, telling it to give up; undefined when every
// one held here is watched or made no claim. The permit changes hands without ever being free, so no other waiter can
// slip in between.
const takeUnwatched = (stream: StreamKind, scope: string): (() => void) | undefined => {
    for (const kept of holdings) {
        const release = kept.release;
        if (kept.stream !== stream || kept.scope !== scope || release === undefined || kept.claim.wanted()) {
            continue;
        }
        kept.release = undefined;
        holdings.delete(kept);
        kept.claim.giveUp();
        return release;
    }
    return undefined;
};

// While `signal` stands, looks every HANDOFF_MS for a permit to take over, whenever its claim says it is watched; the
// permit it took, or undefined once the signal ends the look.
const handedOver = (stream: StreamKind, scope: string, claim: StreamClaim, signal: AbortSignal): Promise<(() => void) | undefined> =>
    new Promise((resolve) => {
        const stop = (taken: (() => void) | undefined): void => {
            clearInterval(timer);
            signal.removeEventListener(`abort`, ended);
            resolve(taken);
        };
        const ended = (): void => stop(undefined);
        const timer = setInterval(() => {
            const taken = claim.wanted() ? takeUnwatched(stream, scope) : undefined;
            if (taken !== undefined) {
                stop(taken);
            }
        }, HANDOFF_MS);
        signal.addEventListener(`abort`, ended, { once: true });
    });

// One round of asking the browser's primitive for a permit (until OVERFLOW_MS), which a claimed stream races against
// taking one over. Whichever it ends up with it keeps; one it got as well goes straight back.
const takeRound = async (
    stream: StreamKind,
    scope: string,
    permits: number,
    signal: AbortSignal | undefined,
    claim: StreamClaim | undefined,
): Promise<(() => void) | undefined> => {
    const ask = (on: AbortSignal | undefined): Promise<(() => void) | undefined> =>
        globalThis.navigator?.locks === undefined
            ? takeCounter(stream, on, OVERFLOW_MS)
            : takeLock(
                  Array.from({ length: permits }, (_, index) => `intentic.stream.${scope}.${stream}.${index}`),
                  on,
                  OVERFLOW_MS,
              );
    if (claim === undefined) {
        return ask(signal);
    }
    // Checked here as well: the round's own signal stands in for the caller's, whose abort may already have fired.
    if (aborted(signal)) {
        return undefined;
    }
    const round = new AbortController();
    const end = (): void => round.abort();
    signal?.addEventListener(`abort`, end, { once: true });
    const asked = ask(round.signal);
    const handed = handedOver(stream, scope, claim, round.signal);
    await Promise.race([asked, handed]);
    end();
    signal?.removeEventListener(`abort`, end);
    const [own, given] = await Promise.all([asked, handed]);
    if (own !== undefined) {
        given?.();
        return own;
    }
    return given;
};

// Takes a permit from whichever primitive the browser provides and resolves what a refusal means; the policy
// is written once here for both.
const takePermit = async (stream: StreamKind, signal: AbortSignal | undefined, claim: StreamClaim | undefined): Promise<(() => void) | undefined> => {
    for (;;) {
        const permits = permitsOf(stream);
        if (permits === Number.POSITIVE_INFINITY) {
            return () => undefined;
        }
        const scope = scopeOf();
        const release = await takeRound(stream, scope, permits, signal, claim);
        if (release !== undefined) {
            return holding(stream, scope, release, claim);
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
// must re-check it after awaiting: an abort landing in that gap is not covered here. A `claim` lets a full pool serve the
// stream somebody is watching first (StreamClaim).
export const acquireStreamSlot = async (stream: StreamKind = `attach`, signal?: AbortSignal, claim?: StreamClaim): Promise<(() => void) | undefined> => {
    // An already-aborted signal never fires again; a caller that queued on one would wait forever.
    if (aborted(signal)) {
        return undefined;
    }
    const permits = permitsOf(stream);
    if (permits === Number.POSITIVE_INFINITY) {
        return () => undefined;
    }
    return takePermit(stream, signal, claim);
};

// Test seam: resets state and moves the lock names to a fresh scope, since Web Locks belong to the browser or
// process and cannot be reset directly.
let resets = 0;

export const resetStreamBudget = (): void => {
    held.events = 0;
    held.attach = 0;
    waiting.events.length = 0;
    waiting.attach.length = 0;
    holdings.clear();
    permitsOf = () => Number.POSITIVE_INFINITY;
    resets += 1;
    const scope = `reset-${resets}`;
    scopeOf = () => scope;
    overflow = () => false;
    protocols.clear();
};
