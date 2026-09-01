import { describe, expect, it } from "vitest";
import {
    applyConnectionSignal,
    classifyFailure,
    type ConnectionSignal,
    type ConnectionState,
    initialConnection,
    isBlocked,
    watchdogRecoveryDelay,
} from "./connection";

// Drive the machine the way the loop does, so a test reads as a sequence of observations rather than a
// hand-built state object.
const drive = (...signals: readonly ConnectionSignal[]): ConnectionState => signals.reduce(applyConnectionSignal, initialConnection);

const network = (message = `tunnel down`) => classifyFailure({ message });
const watchdog = () => classifyFailure({ watchdog: true, message: `The sandbox stopped responding.` });
const forbidden = () => classifyFailure({ status: 403, message: `not a member` });
const failed = (failure = network(), at = 1_000): ConnectionSignal => ({ kind: `failed`, failure, at });
// Frames carry a clock now, because how long a stream WORKED is what a later failure is judged against. The
// default sits at 0 so the ordinary tests below describe a stream that broke almost as soon as it opened.
const frame = (at = 0): ConnectionSignal => ({ kind: `frame`, at });

describe(`classifyFailure`, () => {
    it(`tells our own watchdog apart from a network failure`, () => {
        // Both surface as an aborted fetch: the watchdog aborts the stream itself, so the DRIVER has to say
        // which one it was. This is the sniff (`error.name === "AbortError"`) the machine replaces.
        expect(watchdog().kind).toBe(`timeout`);
        expect(network().kind).toBe(`network`);
    });

    it(`separates a refusal from a failure to connect`, () => {
        expect(forbidden().kind).toBe(`forbidden`);
        expect(classifyFailure({ status: 401, message: `unauthorized` }).kind).toBe(`unauthenticated`);
        expect(classifyFailure({ status: 502, message: `bad gateway` }).kind).toBe(`network`);
    });

    it(`treats a clean stream end as its own cause`, () => {
        // A healthy stream never ends. A daemon that answers 200 and closes is broken in a different way than
        // one that refuses to answer, and hot-reconnecting to it is the failure mode worth naming.
        expect(classifyFailure({ closed: true, message: `stream ended` }).kind).toBe(`closed`);
    });

    it(`classifies only forbidden and unaddressed as blocked`, () => {
        expect(isBlocked(forbidden())).toBe(true);
        expect(isBlocked(classifyFailure({ unaddressed: true, message: `no address` }))).toBe(true);
        expect(isBlocked(network())).toBe(false);
        expect(isBlocked(watchdog())).toBe(false);
        // 401 stays transient: a stale Google token is refreshed on the next attempt, and parking the user on
        // a permanent screen they cannot act on would be wrong.
        expect(isBlocked(classifyFailure({ status: 401, message: `unauthorized` }))).toBe(false);
    });
});

describe(`watchdogRecoveryDelay`, () => {
    it(`an on-time silence trips without grace`, () => {
        expect(watchdogRecoveryDelay(999)).toBe(0);
    });

    it(`a callback delayed by the browser scheduler gets a bounded drain window`, () => {
        expect(watchdogRecoveryDelay(1_000)).toBe(1_000);
        expect(watchdogRecoveryDelay(60_000)).toBe(1_000);
    });
});

describe(`applyConnectionSignal`, () => {
    it(`comes online on the first frame and forgets the previous cause`, () => {
        const state = drive({ kind: `connect` }, failed(), { kind: `connect` }, { kind: `opened` }, frame());
        expect(state.phase).toBe(`online`);
        expect(state.failure).toBeUndefined();
        expect(state.attempt).toBe(0);
        expect(state.everOnline).toBe(true);
        expect(state.unavailableSince).toBeUndefined();
    });

    it(`does not call response headers a recovery before a frame arrives`, () => {
        const state = drive(frame(), failed(network(), 2_000), { kind: `connect` }, { kind: `opened` });
        expect(state.phase).toBe(`connecting`);
        expect(state.failure?.kind).toBe(`network`);
        expect(state.unavailableSince).toBe(2_000);
    });

    it(`keeps the last cause visible while reconnecting`, () => {
        // The connecting gate names why the last reach failed. Blanking it on the retry would leave the user
        // watching an unexplained spinner for the whole backoff window.
        const state = drive({ kind: `connect` }, failed(watchdog()), { kind: `connect` });
        expect(state.phase).toBe(`connecting`);
        expect(state.failure?.kind).toBe(`timeout`);
    });

    it(`returns the identical object for a heartbeat on an already-online connection`, () => {
        // ~1 frame every 2s for the life of the session: minting a new state each time would wake every
        // watcher of the connection for no change.
        const online = drive({ kind: `connect` }, { kind: `opened` }, frame());
        expect(applyConnectionSignal(online, frame())).toBe(online);
    });

    it(`walks the backoff up over consecutive failures and caps it`, () => {
        const fail = failed();
        expect(drive({ kind: `connect` }, fail).retryDelayMs).toBe(1000);
        expect(drive({ kind: `connect` }, fail, fail).retryDelayMs).toBe(2000);
        expect(drive({ kind: `connect` }, fail, fail, fail).retryDelayMs).toBe(4000);
        expect(drive({ kind: `connect` }, fail, fail, fail, fail, fail, fail).retryDelayMs).toBe(5000);
    });

    it(`sends a stream that barely lived back to the top of the ladder, not past it`, () => {
        // A run of failures, then a stream that opened and died almost at once. The climb is reset — this
        // daemon did answer — but a second of life is not proof of anything, so it pays the first rung.
        const fail = failed();
        const state = drive(
            { kind: `connect` },
            fail,
            fail,
            fail,
            { kind: `connect` },
            { kind: `opened` },
            frame(),
            { kind: `connect` },
            fail,
        );
        expect(state.retryDelayMs).toBe(1000);
        expect(state.attempt).toBe(1);
    });

    /* THE ONE-SECOND OUTAGE THAT WAS NOBODY'S FAULT. A liveness stream is open for the life of a tab and ends
     * for reasons that say nothing about reachability; on a loopback shortcut re-opening it costs tens of
     * milliseconds, so a mandatory 1s floor WAS the outage, and it is what the workspace kept rendering. A
     * stream that carried frames long enough to have proved itself is reconnected at once instead. */
    it(`reconnects a stream that had been working at once, and charges it no rung`, () => {
        const state = drive({ kind: `connect` }, { kind: `opened` }, frame(0), failed(network(), 60_000));
        expect(state.phase).toBe(`retrying`);
        expect(state.retryDelayMs).toBe(0);
        expect(state.attempt).toBe(0);
    });

    it(`walks the ladder from its top rung when the free reconnect fails too`, () => {
        // Nothing is proved twice: the repair spent no rung, so the failure after it is the ladder's first.
        const state = drive({ kind: `connect` }, { kind: `opened` }, frame(0), failed(network(), 60_000), { kind: `connect` }, failed(network(), 61_000));
        expect(state.retryDelayMs).toBe(1000);
        expect(state.attempt).toBe(1);
        // And the clock a person is shown still runs from the FIRST failure, not from the retry.
        expect(state.unavailableSince).toBe(60_000);
    });

    it(`never lets a daemon that cannot hold a stream up hot-loop`, () => {
        /* 200-then-close, over and over. Its hello frame resets the ladder every cycle, which is deliberate and
         * unchanged — a daemon that answers IS answering — so this loop is bounded by the floor rather than by
         * the climb, at one attempt per second forever. The thing that must never happen here is a delay of
         * ZERO, and no stream that dies in 50ms can ever earn one. */
        const flap = (at: number): readonly ConnectionSignal[] => [{ kind: `connect` }, { kind: `opened` }, frame(at), failed(network(), at + 50)];
        for (const state of [drive(...flap(0)), drive(...flap(0), ...flap(1_000)), drive(...flap(0), ...flap(1_000), ...flap(2_000))]) {
            expect(state.retryDelayMs).toBe(1000);
            expect(state.attempt).toBe(1);
        }
    });

    it(`refuses the free reconnect to an optimistic paint, which no daemon has confirmed`, () => {
        // A switch paints `online` from this browser's memory of the sandbox. That is a guess, not a frame, so
        // a failure against it is an ordinary first failure however long the paint has been up.
        const state = drive({ kind: `switched`, lastKnownOnline: true }, { kind: `connect` }, failed(network(), 60_000));
        expect(state.retryDelayMs).toBe(1000);
        expect(state.attempt).toBe(1);
    });

    it(`does not hand a repair to a blocked cause`, () => {
        // A long-healthy stream whose daemon then answers 403 is not a connection to be repaired: retrying at
        // once would hammer a daemon working exactly as configured.
        const state = drive({ kind: `connect` }, { kind: `opened` }, frame(0), failed(forbidden(), 60_000));
        expect(state.phase).toBe(`blocked`);
        expect(state.retryDelayMs).toBe(5000);
    });

    it(`pins a blocked cause at the ceiling instead of hammering`, () => {
        // A 403 is the daemon working exactly as configured. Walking the backoff up from 1s would mean four
        // pointless round trips before it settles down.
        const state = drive({ kind: `connect` }, failed(forbidden()));
        expect(state.phase).toBe(`blocked`);
        expect(state.retryDelayMs).toBe(5000);
    });

    it(`clears the outgoing sandbox's failure on a switch`, () => {
        // The previous sandbox being denied says nothing about the incoming one; carrying the cause across
        // would render its gate against the wrong sandbox.
        const state = drive({ kind: `connect` }, failed(forbidden()), { kind: `switched`, lastKnownOnline: false });
        expect(state.failure).toBeUndefined();
        expect(state.phase).toBe(`connecting`);
        expect(state.attempt).toBe(0);
    });

    it(`paints a recently-healthy sandbox immediately on switch, and a never-seen one pessimistically`, () => {
        expect(drive({ kind: `switched`, lastKnownOnline: true }).phase).toBe(`online`);
        expect(drive({ kind: `switched`, lastKnownOnline: false }).phase).toBe(`connecting`);
    });

    it(`lets the optimistic paint survive the reconnect it exists to cover`, () => {
        // The driver signals `connect` immediately after a switch. Demoting the paint there would blank the
        // workspace and disable every daemon query for the round trip: undoing the whole point of it.
        expect(drive({ kind: `switched`, lastKnownOnline: true }, { kind: `connect` }).phase).toBe(`online`);
    });

    it(`corrects a wrong optimistic guess on the first failed attempt`, () => {
        const state = drive({ kind: `switched`, lastKnownOnline: true }, { kind: `connect` }, failed());
        expect(state.phase).toBe(`retrying`);
    });

    it(`bumps the generation on every switch so a stale attempt can be dropped`, () => {
        // The guard against a slow failure landing on the sandbox the user just switched TO.
        const state = drive({ kind: `switched`, lastKnownOnline: false }, { kind: `switched`, lastKnownOnline: false });
        expect(state.generation).toBe(2);
    });

    it(`treats a changed ADDRESS as a retry, not an outage, in either direction`, () => {
        // Promotion: the loopback shortcut qualified mid-stream, so the driver aborts to reconnect onto it.
        // That abort is deliberate; recording it as a failure would put a "reconnecting" gate over a workspace
        // that is about to get FASTER, and would make the first attempt on the new address wait out a backoff.
        const promoted = drive({ kind: `connect` }, { kind: `opened` }, frame(), { kind: `retargeted` });
        expect(promoted.phase).toBe(`connecting`);
        expect(promoted.failure).toBeUndefined();
        expect(promoted.retryDelayMs).toBe(0);

        // Demotion: the shortcut died after a run of real failures. The tunnel is known-good, so the ladder
        // those failures built must not be carried onto it: the next attempt goes out immediately.
        const demoted = drive(failed(network(), 1_000), failed(network(), 2_000), { kind: `retargeted` });
        expect(demoted.attempt).toBe(0);
        expect(demoted.retryDelayMs).toBe(0);

        // The sandbox did not change, so nothing keyed to it goes stale: unlike a switch, which bumps.
        expect(drive({ kind: `retargeted` }).generation).toBe(0);
    });

    it(`returns to idle on disconnect without rewinding the generation`, () => {
        const state = drive({ kind: `switched`, lastKnownOnline: false }, { kind: `connect` }, { kind: `opened` }, { kind: `disconnect` });
        expect(state.phase).toBe(`idle`);
        expect(state.failure).toBeUndefined();
        expect(state.everOnline).toBe(false);
        expect(state.unavailableSince).toBeUndefined();
        // A late attempt from before the teardown must still read as stale if the loop restarts.
        expect(state.generation).toBe(1);
    });
});
