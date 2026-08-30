import type { EndpointKind } from "./endpoint";

/* HOW MANY LONG-LIVED STREAMS THIS ORIGIN MAY HOLD AT ONCE, the guard against the app starving its own requests.
 *
 * A browser allows SIX concurrent HTTP/1.1 connections per origin. This app holds long-lived ones: `/events` for
 * the life of every window, plus an `/agent/attach` for every conversation with a live turn. Five of those took
 * every slot, and the next ordinary read, a file tree, a git status, the reconnect itself, had nowhere to go and
 * simply queued in the browser until some stream ended. The daemon's log stays silent and healthy throughout,
 * because those requests never reach it; only dropping the sockets (reloading every window, or clearing site
 * data) frees it. That is the "the sandbox froze" report, and it is a client-side deadlock with a server-side
 * alibi: measured, the browser waited 221s on requests the daemon answered in a mean of 66ms.
 *
 * The real fix is multiplexing, and it is in place: the loopback listener speaks h2 wherever it has a
 * certificate (see main.ts), and the tunnel's edge speaks h2/h3 regardless, one connection, ~100 streams, cap
 * gone. So this budget is INERT on both of those, and deliberately so: it must not serialize anything that has
 * no reason to be serialized.
 *
 * It binds on exactly one transport, the PLAIN http loopback, which is not a transient state but the permanent
 * one for a sandbox with no zone, an own-Cloudflare sandbox, or one whose CA refused. There, h2 is impossible
 * (no browser speaks cleartext h2), so the only lever left is to not spend every connection on streams.
 *
 * THREE THINGS THIS HAS TO GET RIGHT, each learned from a way the first version did not hold:
 *
 *   · EVERY long-lived stream is counted, `/events` included. It used to budget the attaches alone while the
 *     liveness stream took a whole connection off the books, so the two "reserved for ordinary requests" were
 *     really one, and a single popped-out window took that one too.
 *
 *   · The permits are shared ACROSS WINDOWS, because the socket pool is. A floating chat is a real window
 *     running its own copy of the app (composables/floating.ts), with its own module state, and two copies each
 *     holding "their" four streams want eight connections out of six. Web Locks are the browser's own
 *     cross-window semaphore: same-origin like the pool, and released BY THE BROWSER when a window dies, which
 *     no counter of ours could promise. Where they are missing (tests, SSR) the in-memory counter below stands
 *     in, and a single-realm app is exactly the case that makes it correct.
 *
 *   · A caller that cannot be admitted MOVES rather than waits. Serializing the fifth agent's live view was the
 *     old answer, and it is the wrong one: the tunnel is sitting right there speaking h2 with no cap at all. So
 *     an acquire that cannot be served promptly demotes this window off the shortcut (useEndpoint wires the
 *     handler), the whole window retargets onto the tunnel, capacity goes unbounded, and the queue drains. The
 *     shortcut is then re-probed once its backoff expires, so a window that fits it gets it back. */

// The per-origin ceiling every engine still ships for HTTP/1.1. Not negotiable, not configurable.
const HTTP1_CONNECTIONS_PER_ORIGIN = 6;
// Held back for ordinary requests, the difference between a lagging chat and an unusable workspace.
const RESERVED_FOR_REQUESTS = 2;

/* The two kinds of long-lived stream, split into DISJOINT pools rather than sharing one queue.
 *
 * They have opposite shapes. `/events` is one per window and is what makes a window live at all: queued behind
 * four attaches it would never be served, and that window would render a frozen photograph of the workspace.
 * An attach is one per conversation with a live turn, unbounded in number, and losing one costs a lagging
 * transcript that resumes from its cursor. Sharing a queue lets the unbounded kind starve the essential one, so
 * each gets its own and neither can take the other's. */
export type StreamKind = `events` | `attach`;

const POOLS: Record<StreamKind, number> = {
    // Two windows' worth of liveness: the shell and one popped-out panel, which is the arrangement people
    // actually use. A third window on this transport overflows to the tunnel rather than going blind.
    events: 2,
    // What is left. Four running agents in one window is where the freeze reports came from, and the fifth
    // moves the window to the tunnel instead of waiting on the fourth to finish.
    attach: HTTP1_CONNECTIONS_PER_ORIGIN - RESERVED_FOR_REQUESTS - 2,
};

/* How long an acquire may wait before it gives up on this transport altogether. Long enough that a stream
 * ending normally (a turn settling, a window closing) hands its permit over without anyone moving; short enough
 * that it is never mistaken for the workspace being stuck, which is the whole complaint this file answers. */
const OVERFLOW_MS = 5_000;

export const streamCapacity = (kind: EndpointKind | undefined): number =>
    kind === `local-insecure` ? HTTP1_CONNECTIONS_PER_ORIGIN - RESERVED_FOR_REQUESTS : Number.POSITIVE_INFINITY;

// The permits for one kind of stream on one transport. Unbounded transports keep every pool unbounded: the
// split above is a rationing rule, and there is nothing to ration on h2.
export const streamPermits = (endpoint: EndpointKind | undefined, stream: StreamKind): number =>
    streamCapacity(endpoint) === Number.POSITIVE_INFINITY ? Number.POSITIVE_INFINITY : POOLS[stream];

// Read at every acquire and release rather than snapshotted: the endpoint is resolved in the background and can
// change under a stream that is already running (useEndpoint's whole design), so the budget has to change with it.
let permitsOf: (stream: StreamKind) => number = () => Number.POSITIVE_INFINITY;

export const setStreamCapacity = (read: (stream: StreamKind) => number): void => {
    permitsOf = read;
};

/* WHICH SOCKET POOL THESE PERMITS ARE ABOUT. The lock names have to name the daemon origin, because that is
 * what the browser counts connections against: two windows on two different sandboxes hold two independent
 * pools of six, and one shared set of lock names would ration them as though they were one. */
let scopeOf: () => string = () => `default`;

export const setStreamScope = (read: () => string): void => {
    scopeOf = read;
};

// What a window does when it cannot be admitted: leave this transport (useEndpoint demotes to the tunnel).
// Unset in tests and on the unbounded path, where it can never be reached.
let overflow: () => void = () => undefined;

export const setStreamOverflow = (onOverflow: () => void): void => {
    overflow = onOverflow;
};

/* THE CROSS-WINDOW POOL: one named Web Lock per permit, raced.
 *
 * Racing every name is what makes this a semaphore rather than a queue per slot: whichever permit frees first
 * serves whoever is waiting, no matter which name it was. The loser requests are cancelled the moment one is
 * granted, and aborting a request that has ALREADY been granted does nothing (per spec), so the winner keeps
 * its lock while its siblings stand down.
 *
 * The lock is held by returning a promise that resolves on release, which is the API's own idiom, and it is
 * why nothing here needs to survive a crash: a window that dies never resolves it, and the browser releases
 * every lock that window held. */
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
        // The overflow deadline. Unref'd is not a thing in a browser, but the timer is cleared on every exit
        // path below, so it cannot outlive the acquire it belongs to.
        const timer = setTimeout(standDown, timeoutMs);
        let pending = names.length;
        for (const name of names) {
            void navigator.locks
                .request(name, { signal: race.signal }, async () => {
                    // The caller gave up (abort or deadline) in the same turn this was granted: hand it
                    // straight back rather than holding a permit nobody is going to use. A lock callback
                    // that returns releases, which is exactly what returning here does.
                    if (settled) {
                        return;
                    }
                    clearTimeout(timer);
                    // Cancels the sibling waits only: this one is already granted and keeps its lock.
                    race.abort();
                    finish(release);
                    return held;
                })
                .catch(() => {
                    pending -= 1;
                    // Every name refused (all aborted, or the API rejected). Ignored once one was granted,
                    // whose own abort is what rejected the others.
                    if (pending === 0) {
                        clearTimeout(timer);
                        finish(undefined);
                    }
                });
        }
    });

/* THE SINGLE-REALM FALLBACK, for a browser (or a test) with no Web Locks. Identical rationing, one window's
 * worth: with no second realm to coordinate with, a counter is not an approximation of the answer, it IS the
 * answer. */
const held: Record<StreamKind, number> = { events: 0, attach: 0 };
const waiting: Record<StreamKind, ((granted: boolean) => void)[]> = { events: [], attach: [] };

/* First in, first served, which is what Web Locks does and therefore what this has to do too: one queueing
 * policy for both primitives, or the app's behaviour would depend on which one the browser happened to provide.
 *
 * It used to hand the freed permit to the NEWEST waiter, on the reasoning that the newest stream is the
 * conversation the user just acted on while the older ones are background agents nobody is watching. That
 * reasoning was about a queue you could be stuck in for the length of a turn. There is no such queue now: a
 * waiter that is not served promptly stops waiting and takes its window to the tunnel, so the question the
 * ordering answered ("who suffers the wait") has stopped having a painful answer. */
const pump = (stream: StreamKind): void => {
    while (waiting[stream].length > 0 && held[stream] < permitsOf(stream)) {
        held[stream] += 1;
        waiting[stream].shift()?.(true);
    }
};

// Same contract as `takeLock`: a release, or undefined for "not granted", whether that was an abort or the
// deadline. Which of the two it was is re-read from the signal by the caller, so both primitives answer the
// question the same way and the policy above them is written once.
const takeCounter = async (stream: StreamKind, signal: AbortSignal | undefined, timeoutMs: number): Promise<(() => void) | undefined> => {
    if (held[stream] < permitsOf(stream)) {
        held[stream] += 1;
    } else {
        // Declared out here so it can be cleared once the wait has settled, however it settled: a waiter woken
        // by `pump` would otherwise leave its deadline armed behind it.
        let timer: ReturnType<typeof setTimeout> | undefined;
        const queued = await new Promise<boolean>((resolve) => {
            // `held` is incremented by pump on this waiter's behalf, so a slot cannot be taken twice between
            // the wake and the resumption of this function.
            const wake = resolve;
            waiting[stream].push(wake);
            const standDown = (): void => {
                const at = waiting[stream].indexOf(wake);
                if (at === -1) {
                    // Already woken and already counted, resolve as held so the release below runs.
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

// Release exactly once however often a caller calls it: a double release would let two streams past one permit,
// and turnStream deliberately calls it from several exit paths rather than reasoning about which one it took.
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

// Read through a call rather than inline, so a signal that aborts across an await is re-read instead of
// narrowed to the value it had before it: the whole point of checking twice.
const aborted = (signal: AbortSignal | undefined): boolean => signal?.aborted === true;

/* One rationed acquire: take a permit from whichever primitive this browser has, and decide what a refusal
 * meant. The two primitives answer identically, so the policy is written once here rather than twice. */
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
    /* The deadline passed with every permit still held. This window wants more of this transport than it has,
     * so it stops using it: the tunnel multiplexes and the caller opens there instead of waiting on a socket
     * that is not coming. Handing back a release that holds nothing is correct rather than sloppy, the permit
     * it would have freed is on a transport this window has just left. */
    overflow();
    return () => undefined;
};

/* Take a permit for one long-lived stream, resolving once there is room. Returns the release, call it when the
 * stream ends, however it ends. Undefined means the caller was aborted and should stand down without opening
 * anything; on an unbounded transport it never queues, so this resolves on the spot.
 *
 * A caller that passes a signal must STILL re-check it after awaiting this. Nothing here can cover the hop
 * between this returning and the caller resuming, and a stream opened on a signal that aborted in that gap
 * parks forever, its producer wired teardown to an event that has already fired. See conversation.ts. */
export const acquireStreamSlot = async (stream: StreamKind = `attach`, signal?: AbortSignal): Promise<(() => void) | undefined> => {
    // An already-aborted signal never fires `abort` again, so a caller that queued on one would wait forever.
    if (aborted(signal)) {
        return undefined;
    }
    const permits = permitsOf(stream);
    if (permits === Number.POSITIVE_INFINITY) {
        return () => undefined;
    }
    return takePermit(stream, permits, signal);
};

/* Test seam: the budget is module state, like every other singleton here.
 *
 * The scope is reset to a FRESH one rather than a fixed name, because a Web Lock is not ours to reset. It
 * belongs to the browser (or, under vitest, to the node process, which has had `navigator.locks` since 24), it
 * outlives the module state, and a permit a test took and never released would still be held by the next one.
 * Moving to a new set of names is the only reset that reaches it, and it is exactly the isolation the fixed
 * name was pretending to give. */
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
