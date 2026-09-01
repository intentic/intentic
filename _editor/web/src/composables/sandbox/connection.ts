/* The active sandbox connection, as a state machine, pure, so the whole reconnect policy is testable without
 * a network, a timer, or a Vue instance.
 *
 * The thing this replaces was a boolean triple (`reachable` / `denied` / `probeError`) written from inside the
 * stream loop, which forced every question about the connection to be answered by sniffing: a watchdog trip
 * was told from a real network failure by `error.name === "AbortError"`, and a 403 got its own sticky boolean
 * because the triple had no room for "the daemon answered, and said no". A failure is a VALUE here, tagged by
 * what actually happened, and the phase is derived from it, so a gate renders off `failure.kind` instead of
 * re-deriving the cause from a message string.
 *
 * The transient/blocked split is the one that matters. A TRANSIENT failure means "the daemon we expected did
 * not answer" and is worth retrying fast, that is the restart-a-container case, and the first retry lands in
 * a second. A BLOCKED failure means the daemon answered and refused (403), or there is nothing to dial at all;
 * retrying changes nothing until the user does something, so it backs off to the ceiling immediately rather
 * than hammering a tunnel that is working exactly as configured. */

// Fast first retry (a restarted sandbox should come back within a second), capped so a long outage costs one
// attempt per 5s. Indexed by consecutive-failure count; the last entry is the ceiling.
const RETRY_DELAYS_MS = [1000, 2000, 4000, 5000] as const;

/* HOW LONG A STREAM HAS TO HAVE RUN BEFORE ITS BREAKING COUNTS AS A REPAIR RATHER THAN AN OUTAGE.
 *
 * The ladder above is a policy about a daemon that will not answer. It was also, until this constant existed,
 * being applied to a daemon that answers perfectly: the liveness stream is open for the life of a tab and ends
 * for reasons that say nothing about reachability — a proxy hop recycled, an h2 session displaced by a fresh
 * tunnel, a watchdog trip on a stall the daemon has already come out of — and every one of those spent a
 * deliberate second on the floor before the loop was even allowed to try again. On a loopback shortcut the
 * reconnect itself costs tens of milliseconds, so that second was ~95% of the outage, self-inflicted, and it
 * is what a person actually saw: `reachable` false long enough to render, over and over, on a healthy box.
 *
 * So a stream that PROVED ITSELF gets one reconnect at once, and does not spend a rung of the ladder to get
 * it. Proof is duration: the daemon beats every ~2s, so a stream that carried frames for this long was not a
 * daemon flapping. That is the whole guard, and it is the one that matters — the failure this must never
 * become is the hot loop against a daemon that answers 200 and closes, and such a daemon can never satisfy it
 * (it is torn down in milliseconds, over and over, and walks the ordinary ladder every time).
 *
 * If the free attempt ALSO fails, nothing has been proven twice: `onlineSince` is gone by then, so the next
 * failure starts the ladder from its top rung exactly as before. The cost of being wrong is one extra request. */
const SETTLED_STREAM_MS = 10_000;

// Why the last attempt failed. Every arm is reachable from a real observation, never inferred from a message.
export type ConnectionFailure =
    // No response at all: DNS, TLS, a dead tunnel, a refused connect. The daemon may simply be starting.
    | { readonly kind: "network"; readonly message: string }
    // The stream went silent, no heartbeat within the watchdog window. A half-open connection (the origin
    // died without a TCP FIN) looks healthy at the socket layer, so this is the only thing that catches it.
    | { readonly kind: "timeout"; readonly message: string }
    // The daemon answered and then closed the stream without erroring. Not a failure of ours, but a healthy
    // stream never ends, so reconnecting immediately would hot-loop against a 200-then-close daemon.
    | { readonly kind: "closed"; readonly message: string }
    // 401, no usable identity. The browser's Google token is missing or rejected; a fresh token may fix it,
    // so this stays transient rather than parking the UI on a screen the user cannot act on.
    | { readonly kind: "unauthenticated"; readonly message: string }
    // 403, a VERIFIED identity that is neither the owner nor a member. Retrying is pointless.
    | { readonly kind: "forbidden"; readonly message: string }
    // No daemon URL to dial: setup is unfinished, or the daemon has never announced itself.
    | { readonly kind: "unaddressed"; readonly message: string };

// Retrying will not change the outcome, only the user (or the platform) can. Drives both the gate the shell
// renders and the backoff the driver waits.
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
    // Whether this sandbox has delivered a real frame in this browser session. A previously-live workspace can
    // keep painting through a transport retry; a first visit has no truthful state to preserve yet.
    readonly everOnline: boolean;
    // When the current run of observed failures began. Attempts may open and close several times while the
    // sandbox is starved; keeping one clock across them lets presentation react to elapsed unavailability
    // rather than to how quickly a proxy happens to reject retries.
    readonly unavailableSince: number | undefined;
    /* When the CURRENT stream first carried a frame, which is the only evidence that it works. Undefined
     * whenever nothing is proven: idle, connecting, retrying, and — deliberately — the optimistic `online` a
     * switch paints from memory, which is a guess about a daemon this browser has not heard from yet.
     *
     * Read at exactly one place, the failure below, to tell a long-lived stream breaking (repair it now) from
     * a daemon that cannot hold one up (back off). */
    readonly onlineSince: number | undefined;
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
    // A frame arrived (heartbeat or payload). Proves the connection is alive right now, and `at` is when, which
    // is what lets a later failure ask how long this stream had been working before it broke.
    | { readonly kind: "frame"; readonly at: number }
    | { readonly kind: "failed"; readonly failure: ConnectionFailure; readonly at: number }
    // The user switched sandboxes. `lastKnownOnline` is what this browser last observed for the INCOMING
    // sandbox, which the shell paints optimistically (stale-while-revalidate) while the stream re-establishes.
    | { readonly kind: "switched"; readonly lastKnownOnline: boolean }
    // The ADDRESS changed under an in-flight attempt, the loopback shortcut qualified and was promoted to,
    // or it stopped answering and was demoted back to the tunnel (see useEndpoint). Not a failure of the
    // sandbox in either direction: another address is there to be tried and the very next attempt uses it, so
    // this clears the cause and the backoff instead of climbing the retry ladder against an address we have
    // already stopped using. Without it a promotion would record its own deliberate abort as an outage.
    | { readonly kind: "retargeted" }
    // The shell tore the loop down (logout, unmount).
    | { readonly kind: "disconnect" };

const retryDelayMs = (attempt: number): number => RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)] ?? RETRY_DELAYS_MS.at(-1)!;

/* THE FAILURE ARM, out of the switch because it is the only one that decides a POLICY rather than recording an
 * observation: which of three quite different things just happened, and what each is worth waiting for.
 *
 *   · BLOCKED (403, no address). The daemon answered and said no, or there is nothing to dial. Pinned at the
 *     ceiling: walking up from 1s would be four pointless round trips before settling on the same answer, and
 *     what changes it is a person, on a human timescale.
 *   · A REPAIR. A stream that carried frames for longer than SETTLED_STREAM_MS just ended. That is one
 *     connection dying, not a sandbox going away, so it is reconnected AT ONCE and costs no rung. `onlineSince`
 *     is cleared on the way out, so a free attempt that also fails leaves the next failure at the ladder's top.
 *   · AN OUTAGE. Everything else: walk the ladder. */
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
            // Keep `attempt` (it is the backoff index across a run of failures) and keep `failure` so the
            // connecting gate can still name what went wrong last time instead of blanking mid-reconnect.
            //
            // An OPTIMISTIC `online` survives: the only way to be online here is the paint a switch to a
            // recently-healthy sandbox put up (a genuinely live stream is still inside its own attempt), and
            // demoting it for the duration of the connect is exactly the flicker that paint exists to prevent,
            // the rail would go inert and every daemon query would disable itself for a round trip. The first
            // failed attempt corrects a wrong guess.
            return { ...state, phase: state.phase === `online` ? `online` : `connecting`, retryDelayMs: 0 };
        case `opened`:
            // Response headers are not application liveness. A proxy can answer 200 and leave the body silent;
            // only a decoded frame proves this daemon is serving again. Keeping the previous failure clock here
            // also prevents a 200-then-close loop from looking like a string of fresh, momentary outages.
            return { ...state, phase: state.phase === `online` ? `online` : `connecting`, retryDelayMs: 0 };
        case `frame`: {
            // `onlineSince` is part of the steady state, not just the phase: an OPTIMISTIC online (painted by a
            // switch, from memory) is already `online` with no failure, so without it in the guard the first
            // real frame of that stream would short-circuit and the stream would never record that it works.
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
            // A switch is not a failure: clear the outgoing sandbox's cause, reset the backoff, and let the
            // driver reconnect at once. A never-seen sandbox stays pessimistic so the connecting gate shows
            // rather than a dead workspace; a wrong optimistic guess self-corrects on the first failed attempt.
            //
            // The optimistic `online` carries NO `onlineSince`: it is what this browser remembers, not
            // something the incoming daemon has said, so it must not also buy that daemon a free reconnect.
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
            // Same shape as a switch minus the generation bump: the sandbox did not change, only the address
            // we reach it at, so in-flight results stay valid and the loop retries at once (retryDelayMs 0).
            // The stream that was proving itself is the one being abandoned, so its clock goes with it.
            return { ...state, phase: `connecting`, failure: undefined, attempt: 0, retryDelayMs: 0, onlineSince: undefined };
        case `disconnect`:
            return { ...initialConnection, generation: state.generation };
    }
};

/* A watchdog callback that itself arrived late proves the browser's scheduler was paused (a huge transcript
 * render, background throttling, machine sleep). Aborting the SSE as the FIRST task after that pause turns a
 * healthy buffered connection into a synthetic outage. Give network/iterator tasks one second to drain; a
 * genuinely silent stream still trips immediately after that bounded grace. */
const WATCHDOG_SCHEDULER_LATE_MS = 1_000;
export const watchdogRecoveryDelay = (latenessMs: number): number => (latenessMs >= WATCHDOG_SCHEDULER_LATE_MS ? 1_000 : 0);

// What the driver observed, mapped onto a failure. Kept here (not in the driver) so the mapping is covered by
// the same tests as the transitions it feeds, this is exactly the step that used to be a message sniff.
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
