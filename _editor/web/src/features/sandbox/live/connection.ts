// The active sandbox connection as a pure state machine, testable without a network, timer, or Vue instance;
// failure is a tagged value rather than a boolean triple sniffed from a message. Transient failures retry fast;
// blocked ones (403, no address) back off to the ceiling at once.

// Fast first retry, capped at one attempt per 5s; indexed by failure count, last entry is the ceiling.
const RETRY_DELAYS_MS = [1000, 2000, 4000, 5000] as const;

// How long a stream must have run before its end counts as a repair (free reconnect) rather than an outage.
const SETTLED_STREAM_MS = 10_000;

// Why the last attempt failed. Every arm is reachable from a real observation, never inferred from a message.
export type ConnectionFailure =
    // No response at all: DNS, TLS, a dead tunnel, a refused connect. The daemon may simply be starting.
    | { readonly kind: "network"; readonly message: string }
    // The stream went silent within the watchdog window; catches a half-open connection with no TCP FIN.
    | { readonly kind: "timeout"; readonly message: string }
    // The daemon closed the stream cleanly; a healthy stream never ends, so this avoids hot-looping a reconnect.
    | { readonly kind: "closed"; readonly message: string }
    // 401: the browser's Google token is missing or rejected; stays transient since a fresh token may fix it.
    | { readonly kind: "unauthenticated"; readonly message: string }
    // 403: a verified identity that is neither the owner nor a member. Retrying is pointless.
    | { readonly kind: "forbidden"; readonly message: string }
    // No daemon URL to dial: setup is unfinished, or the daemon has never announced itself.
    | { readonly kind: "unaddressed"; readonly message: string };

// True when only a person or the platform can change the outcome; drives the gate and the backoff.
export const isBlocked = (failure: ConnectionFailure): boolean => failure.kind === `forbidden` || failure.kind === `unaddressed`;

export type ConnectionPhase =
    // Nothing is being attempted, before the shell starts the loop, and after it stops.
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
    // Consecutive failures since the last open stream, the backoff index.
    readonly attempt: number;
    // How long the driver should wait before the next attempt. 0 whenever no retry is pending.
    readonly retryDelayMs: number;
    // Whether this sandbox has delivered a real frame this session, so a live workspace can paint through a retry.
    readonly everOnline: boolean;
    // When the current run of failures began, kept across retries so presentation reflects elapsed time.
    readonly unavailableSince: number | undefined;
    // When the current stream first proved itself with a frame; undefined for any unproven state.
    readonly onlineSince: number | undefined;
    // Bumped on every switch; an in-flight attempt that goes stale is dropped rather than applied.
    readonly generation: number;
}

export const initialConnection: ConnectionState = {
    phase: `idle`,
    failure: undefined,
    attempt: 0,
    retryDelayMs: 0,
    everOnline: false,
    unavailableSince: undefined,
    onlineSince: undefined,
    generation: 0,
};

export type ConnectionSignal =
    // The driver is starting an attempt.
    | { readonly kind: "connect" }
    // The stream answered, headers in, body open.
    | { readonly kind: "opened" }
    // A frame arrived; `at` is when, so a later failure can ask how long the stream had been working.
    | { readonly kind: "frame"; readonly at: number }
    | { readonly kind: "failed"; readonly failure: ConnectionFailure; readonly at: number }
    // The user switched sandboxes; `lastKnownOnline` is the incoming box's last observed state.
    | { readonly kind: "switched"; readonly lastKnownOnline: boolean }
    // The dial address changed mid-attempt; clears cause and backoff instead of climbing the ladder against it.
    | { readonly kind: "retargeted" }
    // The shell tore the loop down (logout, unmount).
    | { readonly kind: "disconnect" };

const retryDelayMs = (attempt: number): number => RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)] ?? RETRY_DELAYS_MS.at(-1)!;

// The failure arm decides policy: blocked (403, no address) pins at the ceiling; a stream that ran past
// SETTLED_STREAM_MS gets a free repair at once; everything else walks the ladder.
const applyFailure = (state: ConnectionState, failure: ConnectionFailure, at: number): ConnectionState => {
    const blocked = isBlocked(failure);
    const repair = !blocked && state.onlineSince !== undefined && at - state.onlineSince >= SETTLED_STREAM_MS;
    return {
        ...state,
        phase: blocked ? `blocked` : `retrying`,
        failure,
        attempt: repair ? state.attempt : state.attempt + 1,
        retryDelayMs: blocked ? retryDelayMs(RETRY_DELAYS_MS.length) : repair ? 0 : retryDelayMs(state.attempt),
        unavailableSince: state.unavailableSince ?? at,
        onlineSince: undefined,
    };
};

export const applyConnectionSignal = (state: ConnectionState, signal: ConnectionSignal): ConnectionState => {
    switch (signal.kind) {
        case `connect`:
            // Keeps `attempt` and `failure` across a reconnect; an optimistic `online` survives so it doesn't flicker.
            return { ...state, phase: state.phase === `online` ? `online` : `connecting`, retryDelayMs: 0 };
        case `opened`:
            // Headers aren't liveness: a proxy can answer 200 with a silent body; only a frame proves it's serving.
            return { ...state, phase: state.phase === `online` ? `online` : `connecting`, retryDelayMs: 0 };
        case `frame`: {
            // Guards on `onlineSince` too, since an optimistic `online` already has no failure to short-circuit on.
            if (state.phase === `online` && state.failure === undefined && state.onlineSince !== undefined) {
                // Steady state, every heartbeat would otherwise mint an identical object and wake every watcher.
                return state;
            }
            return {
                ...state,
                phase: `online`,
                failure: undefined,
                attempt: 0,
                retryDelayMs: 0,
                everOnline: true,
                unavailableSince: undefined,
                onlineSince: signal.at,
            };
        }
        case `failed`:
            return applyFailure(state, signal.failure, signal.at);
        case `switched`:
            // A switch isn't a failure: backoff resets, and the optimistic `online` earns no free reconnect.
            return {
                phase: signal.lastKnownOnline ? `online` : `connecting`,
                failure: undefined,
                attempt: 0,
                retryDelayMs: 0,
                everOnline: signal.lastKnownOnline,
                unavailableSince: undefined,
                onlineSince: undefined,
                generation: state.generation + 1,
            };
        case `retargeted`:
            // Like a switch without the generation bump: only the address changed, so in-flight results stay valid.
            return { ...state, phase: `connecting`, failure: undefined, attempt: 0, retryDelayMs: 0, onlineSince: undefined };
        case `disconnect`:
            return { ...initialConnection, generation: state.generation };
    }
};

// A late watchdog callback means the scheduler was paused, not that the stream is dead; aborting immediately would
// fake an outage, so queued network tasks get one second to drain before tripping for real.
const WATCHDOG_SCHEDULER_LATE_MS = 1_000;
export const watchdogRecoveryDelay = (latenessMs: number): number => (latenessMs >= WATCHDOG_SCHEDULER_LATE_MS ? 1_000 : 0);

// Maps what the driver observed onto a failure, covered by the same tests as the transitions it feeds.
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
