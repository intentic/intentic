import { describe, expect, it } from "vitest";
import {
    applyConnectionSignal,
    classifyFailure,
    type ConnectionSignal,
    type ConnectionState,
    initialConnection,
    isBlocked,
    showOutageGate,
} from "./connection";

// Drive the machine the way the loop does, so a test reads as a sequence of observations rather than a
// hand-built state object.
const drive = (...signals: readonly ConnectionSignal[]): ConnectionState => signals.reduce(applyConnectionSignal, initialConnection);

const network = (message = `tunnel down`) => classifyFailure({ message });
const watchdog = () => classifyFailure({ watchdog: true, message: `The sandbox stopped responding.` });
const forbidden = () => classifyFailure({ status: 403, message: `not a member` });

describe(`classifyFailure`, () => {
    it(`tells our own watchdog apart from a network failure`, () => {
        // Both surface as an aborted fetch — the watchdog aborts the stream itself — so the DRIVER has to say
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

describe(`showOutageGate`, () => {
    it(`rides out one transient failure and gates on the second`, () => {
        // One missed-watchdog blip (a daemon briefly starved under its own builds) heals on the next attempt;
        // tearing the workspace down for it is what made every stall read as an outage.
        expect(showOutageGate(drive({ kind: `failed`, failure: watchdog() }))).toBe(false);
        expect(showOutageGate(drive({ kind: `failed`, failure: watchdog() }, { kind: `failed`, failure: network() }))).toBe(true);
    });

    it(`gates a blocked cause immediately — retrying will not change a 403`, () => {
        expect(showOutageGate(drive({ kind: `failed`, failure: forbidden() }))).toBe(true);
    });

    it(`never gates while nothing has failed`, () => {
        expect(showOutageGate(initialConnection)).toBe(false);
        expect(showOutageGate(drive({ kind: `connect` }, { kind: `opened` }))).toBe(false);
        // Recovery clears the gate even after a long run of failures.
        expect(showOutageGate(drive({ kind: `failed`, failure: network() }, { kind: `failed`, failure: network() }, { kind: `frame` }))).toBe(false);
    });
});

describe(`applyConnectionSignal`, () => {
    it(`comes online on the first frame and forgets the previous cause`, () => {
        const state = drive({ kind: `connect` }, { kind: `failed`, failure: network() }, { kind: `connect` }, { kind: `opened` });
        expect(state.phase).toBe(`online`);
        expect(state.failure).toBeUndefined();
        expect(state.attempt).toBe(0);
    });

    it(`keeps the last cause visible while reconnecting`, () => {
        // The connecting gate names why the last reach failed. Blanking it on the retry would leave the user
        // watching an unexplained spinner for the whole backoff window.
        const state = drive({ kind: `connect` }, { kind: `failed`, failure: watchdog() }, { kind: `connect` });
        expect(state.phase).toBe(`connecting`);
        expect(state.failure?.kind).toBe(`timeout`);
    });

    it(`returns the identical object for a heartbeat on an already-online connection`, () => {
        // ~1 frame every 2s for the life of the session: minting a new state each time would wake every
        // watcher of the connection for no change.
        const online = drive({ kind: `connect` }, { kind: `opened` });
        expect(applyConnectionSignal(online, { kind: `frame` })).toBe(online);
    });

    it(`walks the backoff up over consecutive failures and caps it`, () => {
        const fail = { kind: `failed`, failure: network() } as const;
        expect(drive({ kind: `connect` }, fail).retryDelayMs).toBe(1000);
        expect(drive({ kind: `connect` }, fail, fail).retryDelayMs).toBe(2000);
        expect(drive({ kind: `connect` }, fail, fail, fail).retryDelayMs).toBe(4000);
        expect(drive({ kind: `connect` }, fail, fail, fail, fail, fail, fail).retryDelayMs).toBe(5000);
    });

    it(`earns back the fast first retry after a healthy stream`, () => {
        const fail = { kind: `failed`, failure: network() } as const;
        const state = drive({ kind: `connect` }, fail, fail, fail, { kind: `connect` }, { kind: `opened` }, { kind: `connect` }, fail);
        expect(state.retryDelayMs).toBe(1000);
        expect(state.attempt).toBe(1);
    });

    it(`pins a blocked cause at the ceiling instead of hammering`, () => {
        // A 403 is the daemon working exactly as configured. Walking the backoff up from 1s would mean four
        // pointless round trips before it settles down.
        const state = drive({ kind: `connect` }, { kind: `failed`, failure: forbidden() });
        expect(state.phase).toBe(`blocked`);
        expect(state.retryDelayMs).toBe(5000);
    });

    it(`clears the outgoing sandbox's failure on a switch`, () => {
        // The previous sandbox being denied says nothing about the incoming one; carrying the cause across
        // would render its gate against the wrong sandbox.
        const state = drive({ kind: `connect` }, { kind: `failed`, failure: forbidden() }, { kind: `switched`, lastKnownOnline: false });
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
        // workspace and disable every daemon query for the round trip — undoing the whole point of it.
        expect(drive({ kind: `switched`, lastKnownOnline: true }, { kind: `connect` }).phase).toBe(`online`);
    });

    it(`corrects a wrong optimistic guess on the first failed attempt`, () => {
        const state = drive({ kind: `switched`, lastKnownOnline: true }, { kind: `connect` }, { kind: `failed`, failure: network() });
        expect(state.phase).toBe(`retrying`);
    });

    it(`bumps the generation on every switch so a stale attempt can be dropped`, () => {
        // The guard against a slow failure landing on the sandbox the user just switched TO.
        const state = drive({ kind: `switched`, lastKnownOnline: false }, { kind: `switched`, lastKnownOnline: false });
        expect(state.generation).toBe(2);
    });

    it(`treats a changed ADDRESS as a retry, not an outage — in either direction`, () => {
        // Promotion: the loopback shortcut qualified mid-stream, so the driver aborts to reconnect onto it.
        // That abort is deliberate; recording it as a failure would put a "reconnecting" gate over a workspace
        // that is about to get FASTER, and would make the first attempt on the new address wait out a backoff.
        const promoted = drive({ kind: `connect` }, { kind: `opened` }, { kind: `retargeted` });
        expect(promoted.phase).toBe(`connecting`);
        expect(promoted.failure).toBeUndefined();
        expect(promoted.retryDelayMs).toBe(0);

        // Demotion: the shortcut died after a run of real failures. The tunnel is known-good, so the ladder
        // those failures built must not be carried onto it — the next attempt goes out immediately.
        const demoted = drive({ kind: `failed`, failure: network() }, { kind: `failed`, failure: network() }, { kind: `retargeted` });
        expect(demoted.attempt).toBe(0);
        expect(demoted.retryDelayMs).toBe(0);

        // The sandbox did not change, so nothing keyed to it goes stale — unlike a switch, which bumps.
        expect(drive({ kind: `retargeted` }).generation).toBe(0);
    });

    it(`returns to idle on disconnect without rewinding the generation`, () => {
        const state = drive({ kind: `switched`, lastKnownOnline: false }, { kind: `connect` }, { kind: `opened` }, { kind: `disconnect` });
        expect(state.phase).toBe(`idle`);
        expect(state.failure).toBeUndefined();
        // A late attempt from before the teardown must still read as stale if the loop restarts.
        expect(state.generation).toBe(1);
    });
});
