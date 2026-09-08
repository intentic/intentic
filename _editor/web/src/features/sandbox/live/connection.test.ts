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

// Drives the machine like the loop does, so a test reads as observations rather than a hand-built state.
const drive = (...signals: readonly ConnectionSignal[]): ConnectionState => signals.reduce(applyConnectionSignal, initialConnection);

const network = (message = `tunnel down`) => classifyFailure({ message });
const watchdog = () => classifyFailure({ watchdog: true, message: `The sandbox stopped responding.` });
const forbidden = () => classifyFailure({ status: 403, message: `not a member` });
const failed = (failure = network(), at = 1_000): ConnectionSignal => ({ kind: `failed`, failure, at });
// Frames carry a clock: how long a stream worked is what a later failure is judged against.
const frame = (at = 0): ConnectionSignal => ({ kind: `frame`, at });

describe(`classifyFailure`, () => {
    it(`tells our own watchdog apart from a network failure`, () => {
        // Both surface as an aborted fetch; the driver has to say which one it was, replacing an `AbortError` sniff.
        expect(watchdog().kind).toBe(`timeout`);
        expect(network().kind).toBe(`network`);
    });

    it(`separates a refusal from a failure to connect`, () => {
        expect(forbidden().kind).toBe(`forbidden`);
        expect(classifyFailure({ status: 401, message: `unauthorized` }).kind).toBe(`unauthenticated`);
        expect(classifyFailure({ status: 502, message: `bad gateway` }).kind).toBe(`network`);
    });

    it(`treats a clean stream end as its own cause`, () => {
        // A healthy stream never ends; a 200-then-close daemon is broken differently than one that refuses to answer.
        expect(classifyFailure({ closed: true, message: `stream ended` }).kind).toBe(`closed`);
    });

    it(`classifies only forbidden and unaddressed as blocked`, () => {
        expect(isBlocked(forbidden())).toBe(true);
        expect(isBlocked(classifyFailure({ unaddressed: true, message: `no address` }))).toBe(true);
        expect(isBlocked(network())).toBe(false);
        expect(isBlocked(watchdog())).toBe(false);
        // 401 stays transient, since a stale Google token is refreshed on the next attempt.
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
        // Blanking the cause on retry would leave the user watching an unexplained spinner through the backoff.
        const state = drive({ kind: `connect` }, failed(watchdog()), { kind: `connect` });
        expect(state.phase).toBe(`connecting`);
        expect(state.failure?.kind).toBe(`timeout`);
    });

    it(`returns the identical object for a heartbeat on an already-online connection`, () => {
        // Frames arrive every ~2s for the session's life; minting a new state each time would wake every watcher.
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
        // A stream that opened and died almost at once resets the climb but still pays the first rung.
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
        // And the clock a person is shown still runs from the first failure, not from the retry.
        expect(state.unavailableSince).toBe(60_000);
    });

    it(`never lets a daemon that cannot hold a stream up hot-loop`, () => {
        // A daemon that answers 200-then-close resets the ladder each cycle but must never earn a zero-delay retry.
        const flap = (at: number): readonly ConnectionSignal[] => [{ kind: `connect` }, { kind: `opened` }, frame(at), failed(network(), at + 50)];
        for (const state of [drive(...flap(0)), drive(...flap(0), ...flap(1_000)), drive(...flap(0), ...flap(1_000), ...flap(2_000))]) {
            expect(state.retryDelayMs).toBe(1000);
            expect(state.attempt).toBe(1);
        }
    });

    it(`refuses the free reconnect to an optimistic paint, which no daemon has confirmed`, () => {
        // A switch-painted `online` is a guess, not a frame; a failure against it is an ordinary first one.
        const state = drive({ kind: `switched`, lastKnownOnline: true }, { kind: `connect` }, failed(network(), 60_000));
        expect(state.retryDelayMs).toBe(1000);
        expect(state.attempt).toBe(1);
    });

    it(`does not hand a repair to a blocked cause`, () => {
        // A 403 after a long-healthy stream isn't a repair case; retrying at once would hammer a working daemon.
        const state = drive({ kind: `connect` }, { kind: `opened` }, frame(0), failed(forbidden(), 60_000));
        expect(state.phase).toBe(`blocked`);
        expect(state.retryDelayMs).toBe(5000);
    });

    it(`pins a blocked cause at the ceiling instead of hammering`, () => {
        // A 403 is the daemon working as configured; walking the backoff up would mean pointless round trips first.
        const state = drive({ kind: `connect` }, failed(forbidden()));
        expect(state.phase).toBe(`blocked`);
        expect(state.retryDelayMs).toBe(5000);
    });

    it(`clears the outgoing sandbox's failure on a switch`, () => {
        // A denial on the outgoing sandbox says nothing about the incoming one, so the cause doesn't carry over.
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
        // The driver signals `connect` right after a switch; demoting the paint would blank the workspace for nothing.
        expect(drive({ kind: `switched`, lastKnownOnline: true }, { kind: `connect` }).phase).toBe(`online`);
    });

    it(`corrects a wrong optimistic guess on the first failed attempt`, () => {
        const state = drive({ kind: `switched`, lastKnownOnline: true }, { kind: `connect` }, failed());
        expect(state.phase).toBe(`retrying`);
    });

    it(`bumps the generation on every switch so a stale attempt can be dropped`, () => {
        // The guard against a slow failure landing on the sandbox the user just switched to.
        const state = drive({ kind: `switched`, lastKnownOnline: false }, { kind: `switched`, lastKnownOnline: false });
        expect(state.generation).toBe(2);
    });

    it(`treats a changed ADDRESS as a retry, not an outage, in either direction`, () => {
        // Promotion: the loopback qualified mid-stream; recording the abort as failure would cost a needless backoff.
        const promoted = drive({ kind: `connect` }, { kind: `opened` }, frame(), { kind: `retargeted` });
        expect(promoted.phase).toBe(`connecting`);
        expect(promoted.failure).toBeUndefined();
        expect(promoted.retryDelayMs).toBe(0);

        // Demotion: the shortcut died after real failures; the known-good tunnel doesn't inherit that ladder.
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
