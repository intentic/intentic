/* The active sandbox connection, as a state machine — pure, so the whole reconnect policy is testable without
 * a network, a timer, or a Vue instance.
 *
 * The thing this replaces was a boolean triple (`reachable` / `denied` / `probeError`) written from inside the
 * stream loop, which forced every question about the connection to be answered by sniffing: a watchdog trip
 * was told from a real network failure by `error.name === "AbortError"`, and a 403 got its own sticky boolean
 * because the triple had no room for "the daemon answered, and said no". A failure is a VALUE here, tagged by
 * what actually happened, and the phase is derived from it — so a gate renders off `failure.kind` instead of
 * re-deriving the cause from a message string.
 *
 * The transient/blocked split is the load-bearing one. A TRANSIENT failure means "the daemon we expected did
 * not answer" and is worth retrying fast — that is the restart-a-container case, and the first retry lands in
 * a second. A BLOCKED failure means the daemon answered and refused (403), or there is nothing to dial at all;
 * retrying changes nothing until the user does something, so it backs off to the ceiling immediately rather
 * than hammering a tunnel that is working exactly as configured. */

// Fast first retry (a restarted sandbox should come back within a second), capped so a long outage costs one
// attempt per 5s. Indexed by consecutive-failure count; the last entry is the ceiling.
const RETRY_DELAYS_MS = [1000, 2000, 4000, 5000] as const;

// Why the last attempt failed. Every arm is reachable from a real observation, never inferred from a message.
export type ConnectionFailure =
    // No response at all: DNS, TLS, a dead tunnel, a refused connect. The daemon may simply be starting.
    | { readonly kind: "network"; readonly message: string }
    // The stream went silent — no heartbeat within the watchdog window. A half-open connection (the origin
    // died without a TCP FIN) looks healthy at the socket layer, so this is the only thing that catches it.
    | { readonly kind: "timeout"; readonly message: string }
    // The daemon answered and then closed the stream without erroring. Not a failure of ours, but a healthy
    // stream never ends, so reconnecting immediately would hot-loop against a 200-then-close daemon.
    | { readonly kind: "closed"; readonly message: string }
    // 401 — no usable identity. The browser's Google token is missing or rejected; a fresh token may fix it,
    // so this stays transient rather than parking the UI on a screen the user cannot act on.
    | { readonly kind: "unauthenticated"; readonly message: string }
    // 403 — a VERIFIED identity that is neither the owner nor a member. Retrying is pointless.
    | { readonly kind: "forbidden"; readonly message: string }
    // No daemon URL to dial: setup is unfinished, or the daemon has never announced itself.
    | { readonly kind: "unaddressed"; readonly message: string };

export type ConnectionFailureKind = ConnectionFailure["kind"];

// Retrying will not change the outcome — only the user (or the platform) can. Drives both the gate the shell
// renders and the backoff the driver waits.
export const isBlocked = (failure: ConnectionFailure): boolean => failure.kind === `forbidden` || failure.kind === `unaddressed`;

export type ConnectionPhase =
    // Nothing is being attempted — before the shell starts the loop, and after it stops.
    | "idle"
    // An attempt is in flight, and no attempt has failed since the last success.
    | "connecting"
    // The stream is open and delivering frames.
    | "online"
    // An attempt failed with a transient cause; another is scheduled.
    | "retrying"
    // The daemon (or the platform) gave a definitive no. Still re-attempted, but at the ceiling.
    | "blocked";

export interface ConnectionState {
    readonly phase: ConnectionPhase;
    // Why the last attempt failed; undefined while online, idle, or on a first attempt that hasn't failed yet.
    readonly failure: ConnectionFailure | undefined;
    // Consecutive failures since the last open stream — the backoff index.
    readonly attempt: number;
    // How long the driver should wait before the next attempt. 0 whenever no retry is pending.
    readonly retryDelayMs: number;
    // Bumped on every sandbox switch. The driver stamps its in-flight attempt with the generation it started
    // under and drops any result whose generation is stale, so a slow failure against the PREVIOUS sandbox
    // can never write a failure onto the new one.
    readonly generation: number;
}

export const initialConnection: ConnectionState = {
    phase: `idle`,
    failure: undefined,
    attempt: 0,
    retryDelayMs: 0,
    generation: 0,
};

export type ConnectionSignal =
    // The driver is starting an attempt.
    | { readonly kind: "connect" }
    // The stream answered — headers in, body open.
    | { readonly kind: "opened" }
    // A frame arrived (heartbeat or payload). Proves the connection is alive right now.
    | { readonly kind: "frame" }
    | { readonly kind: "failed"; readonly failure: ConnectionFailure }
    // The user switched sandboxes. `lastKnownOnline` is what this browser last observed for the INCOMING
    // sandbox, which the shell paints optimistically (stale-while-revalidate) while the stream re-establishes.
    | { readonly kind: "switched"; readonly lastKnownOnline: boolean }
    // The shell tore the loop down (logout, unmount).
    | { readonly kind: "disconnect" };

const retryDelayMs = (attempt: number): number => RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)] ?? RETRY_DELAYS_MS.at(-1)!;

export const applyConnectionSignal = (state: ConnectionState, signal: ConnectionSignal): ConnectionState => {
    switch (signal.kind) {
        case `connect`:
            // Keep `attempt` (it is the backoff index across a run of failures) and keep `failure` so the
            // connecting gate can still name what went wrong last time instead of blanking mid-reconnect.
            //
            // An OPTIMISTIC `online` survives: the only way to be online here is the paint a switch to a
            // recently-healthy sandbox put up (a genuinely live stream is still inside its own attempt), and
            // demoting it for the duration of the connect is exactly the flicker that paint exists to prevent —
            // the rail would go inert and every daemon query would disable itself for a round trip. The first
            // failed attempt corrects a wrong guess.
            return { ...state, phase: state.phase === `online` ? `online` : `connecting`, retryDelayMs: 0 };
        case `opened`:
        case `frame`: {
            if (state.phase === `online` && state.failure === undefined) {
                // Steady state — every heartbeat would otherwise mint an identical object and wake every watcher.
                return state;
            }
            return { ...state, phase: `online`, failure: undefined, attempt: 0, retryDelayMs: 0 };
        }
        case `failed`: {
            // A blocked cause pins the backoff at the ceiling rather than walking up from 1s: the answer is
            // not going to change on its own, and a member being re-invited is a human-timescale event.
            const attempt = state.attempt + 1;
            const blocked = isBlocked(signal.failure);
            return {
                ...state,
                phase: blocked ? `blocked` : `retrying`,
                failure: signal.failure,
                attempt,
                retryDelayMs: blocked ? retryDelayMs(RETRY_DELAYS_MS.length) : retryDelayMs(state.attempt),
            };
        }
        case `switched`:
            // A switch is not a failure: clear the outgoing sandbox's cause, reset the backoff, and let the
            // driver reconnect at once. A never-seen sandbox stays pessimistic so the connecting gate shows
            // rather than a dead workspace; a wrong optimistic guess self-corrects on the first failed attempt.
            return {
                phase: signal.lastKnownOnline ? `online` : `connecting`,
                failure: undefined,
                attempt: 0,
                retryDelayMs: 0,
                generation: state.generation + 1,
            };
        case `disconnect`:
            return { ...initialConnection, generation: state.generation };
    }
};

// What the driver observed, mapped onto a failure. Kept here (not in the driver) so the mapping is covered by
// the same tests as the transitions it feeds — this is exactly the step that used to be a message sniff.
export const classifyFailure = (observation: {
    // The HTTP status the daemon answered with, when it answered at all.
    readonly status?: number;
    // The stream was aborted by our own watchdog (no heartbeat in the window) rather than by the network.
    readonly watchdog?: boolean;
    // The daemon has no address to dial.
    readonly unaddressed?: boolean;
    // The stream ended cleanly instead of erroring.
    readonly closed?: boolean;
    readonly message: string;
}): ConnectionFailure => {
    if (observation.unaddressed === true) {
        return { kind: `unaddressed`, message: observation.message };
    }
    if (observation.closed === true) {
        return { kind: `closed`, message: observation.message };
    }
    if (observation.watchdog === true) {
        return { kind: `timeout`, message: observation.message };
    }
    if (observation.status === 403) {
        return { kind: `forbidden`, message: observation.message };
    }
    if (observation.status === 401) {
        return { kind: `unauthenticated`, message: observation.message };
    }
    return { kind: `network`, message: observation.message };
};
