import type { EndpointKind } from "./endpoint";

/* HOW MANY LONG-LIVED STREAMS ONE TAB MAY HOLD AT ONCE — the guard against the app starving its own requests.
 *
 * A browser allows SIX concurrent HTTP/1.1 connections per origin. This app holds long-lived ones: `/events` for
 * the life of the tab, plus an `/agent/attach` for every conversation with a live turn (and a popped-out window
 * shares the same origin). Five running agents therefore took every slot, and the next ordinary read — a file
 * tree, a git status, the reconnect itself — had nowhere to go and simply queued in the browser until some
 * stream ended. The daemon's log stays silent and healthy throughout, because those requests never reach it;
 * only dropping the sockets (reloading every tab, or clearing site data) frees it. That is the "the sandbox
 * froze" report, and it is a client-side deadlock with a server-side alibi.
 *
 * The real fix is multiplexing, and it is in place: the loopback listener speaks h2 wherever it has a
 * certificate (see main.ts), and the tunnel's edge speaks h2 regardless — one connection, ~100 streams, cap
 * gone. So this budget is INERT on both of those, and deliberately so: it must not serialize anything that has
 * no reason to be serialized.
 *
 * It binds on exactly one transport — the PLAIN http loopback, which is not a transient state but the permanent
 * one for a sandbox with no zone, an own-Cloudflare sandbox, or one whose CA refused. There, h2 is impossible
 * (no browser speaks cleartext h2), so the only lever left is to not spend every connection on streams. Holding
 * two back turns the failure from "the workspace stopped answering" into "the fifth agent's live view lags
 * until a slot frees" — and nothing is lost by that wait, because runs are detached daemon-side and an attach
 * resumes from its cursor (see conversation.ts). */

// The per-origin ceiling every engine still ships for HTTP/1.1. Not negotiable, not configurable.
const HTTP1_CONNECTIONS_PER_ORIGIN = 6;
// Held back for ordinary requests — the difference between a lagging chat and an unusable workspace.
const RESERVED_FOR_REQUESTS = 2;

export const streamCapacity = (kind: EndpointKind | undefined): number =>
    kind === `local-insecure` ? HTTP1_CONNECTIONS_PER_ORIGIN - RESERVED_FOR_REQUESTS : Number.POSITIVE_INFINITY;

// Read at every acquire and release rather than snapshotted: the endpoint is resolved in the background and can
// change under a stream that is already running (useEndpoint's whole design), so the budget has to change with it.
let capacityOf: () => number = () => Number.POSITIVE_INFINITY;

export const setStreamCapacity = (read: () => number): void => {
    capacityOf = read;
};

let held = 0;
const waiting: (() => void)[] = [];

/* Hand the freed slot to the NEWEST waiter, not the oldest. A queue only forms in the capped case, and there the
 * newest stream is the conversation the user just acted on, while the older ones are background agents whose
 * output they are not watching. Serving the visible thing first is the behaviour worth having; the cost is that
 * a background agent can wait out several turns, which beats every one of them waiting. */
const pump = (): void => {
    while (waiting.length > 0 && held < capacityOf()) {
        held += 1;
        waiting.pop()?.();
    }
};

/* Take a slot for one long-lived stream, resolving once there is room. Returns the release — call it when the
 * stream ends, however it ends. Undefined means the caller was aborted and should stand down without opening
 * anything; on an unbounded transport it never queues, so this resolves on the spot.
 *
 * A caller that passes a signal must STILL re-check it after awaiting this. Nothing here can cover the hop
 * between this returning and the caller resuming, and a stream opened on a signal that aborted in that gap
 * parks forever — its producer wired teardown to an event that has already fired. See conversation.ts. */
export const acquireStreamSlot = async (signal?: AbortSignal): Promise<(() => void) | undefined> => {
    // An already-aborted signal never fires `abort` again, so a caller that queued on one would wait forever.
    if (signal?.aborted === true) {
        return undefined;
    }
    if (held < capacityOf()) {
        held += 1;
    } else {
        const queued = await new Promise<boolean>((resolve) => {
            // `held` is incremented by pump on this waiter's behalf, so a slot cannot be taken twice between
            // the wake and the resumption of this function.
            const wake = (): void => resolve(true);
            waiting.push(wake);
            signal?.addEventListener(
                `abort`,
                () => {
                    const at = waiting.indexOf(wake);
                    if (at === -1) {
                        // Already woken and already counted — resolve as held so the release below runs.
                        resolve(true);
                        return;
                    }
                    waiting.splice(at, 1);
                    resolve(false);
                },
                { once: true },
            );
        });
        if (!queued) {
            return undefined;
        }
    }
    let released = false;
    const release = (): void => {
        if (released) {
            return;
        }
        released = true;
        held -= 1;
        pump();
    };
    return release;
};

// Test seam: the budget is module state, like every other singleton here.
export const resetStreamBudget = (): void => {
    held = 0;
    waiting.length = 0;
    capacityOf = () => Number.POSITIVE_INFINITY;
};
