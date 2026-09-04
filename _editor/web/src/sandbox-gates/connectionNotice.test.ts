import { describe, expect, it } from "vitest";
import { classifyFailure, type ConnectionFailure } from "../composables/sandbox/connection";
import { connectionNotice, HOSTED_STUCK_AFTER_MS } from "./connectionNotice";

// The ordinary case every test below varies one fact of: somebody's own computer, freshly unreachable.
const notice = (failure: ConnectionFailure | undefined, over: { hostedMachine?: boolean; outageMs?: number; sandboxName?: string } = {}) =>
    connectionNotice({ failure, sandboxName: `laptop`, hostedMachine: false, outageMs: 0, ...over });

describe(`connectionNotice`, () => {
    it(`offers nothing to click while an ordinary first connect is in flight`, () => {
        // Nothing is wrong yet. A "Reconnect" button here invites the user to fix what clears itself.
        const shown = notice(undefined);
        expect(shown.action).toBeUndefined();
        expect(shown.title).toContain(`laptop`);
    });

    it(`sends a never-announced sandbox to setup, not to a reconnect`, () => {
        expect(notice(classifyFailure({ unaddressed: true, message: `no address` })).action).toEqual({ kind: `setup`, label: `Finish setup` });
    });

    it(`asks for a sign-in on 401 rather than blaming the sandbox`, () => {
        // The sandbox is fine; the browser's token is not. Offering "Reconnect" would point at the wrong thing.
        const shown = notice(classifyFailure({ status: 401, message: `unauthorized` }));
        expect(shown.action?.kind).toBe(`signin`);
        expect(shown.body).toContain(`expired`);
    });

    it(`keeps transient timeout and network failures automatic and non-diagnostic`, () => {
        const timeout = notice(classifyFailure({ watchdog: true, message: `silent` }));
        const network = notice(classifyFailure({ message: `failed to fetch` }));
        expect(timeout.title).not.toBe(network.title);
        expect(timeout.body).not.toContain(`heartbeat`);
        expect(timeout.action).toBeUndefined();
        expect(network.action).toBeUndefined();
    });

    it(`keeps a mid-restart daemon actionless`, () => {
        expect(notice(classifyFailure({ closed: true, message: `closed` })).action).toBeUndefined();
    });

    it(`names the sandbox even when the list hasn't loaded`, () => {
        expect(connectionNotice({ failure: undefined, sandboxName: undefined, hostedMachine: false, outageMs: 0 }).title).toContain(`your sandbox`);
    });
});

/* THE SCREEN THIS WAS REPORTED FOR. A hosted machine that boots and dies (or never comes back at all) leaves
 * the workspace on a spinner reading "Waiting for the sandbox to answer" with nothing on it to press, for as
 * long as the tab is open — while the browser's wake reflex fires into the dead box every minute. The setup
 * screen already knows how to say what the machine is doing and how to start it over, so past a minute this
 * gate stops calling it a wait and points there. */
describe(`a machine the platform runs, that is not coming back`, () => {
    const dead = classifyFailure({ message: `failed to fetch` });

    it(`still waits patiently for the first minute`, () => {
        expect(notice(dead, { hostedMachine: true, outageMs: HOSTED_STUCK_AFTER_MS - 1 }).action).toBeUndefined();
    });

    it(`names the machine and offers the way to it once the wait stops being one`, () => {
        const shown = notice(dead, { hostedMachine: true, outageMs: HOSTED_STUCK_AFTER_MS });
        expect(shown.action).toEqual({ kind: `setup`, label: `Check the machine` });
        expect(shown.title).toContain(`laptop`);
    });

    // Every network-shaped cause is the same fact about a box we run: a watchdog trip and a refused connect
    // are two ways of observing "it is not answering", and only one of them may be told to keep waiting.
    it(`treats a silent stream and a closed one exactly like a refused connect`, () => {
        for (const failure of [classifyFailure({ watchdog: true, message: `silent` }), classifyFailure({ closed: true, message: `closed` })]) {
            expect(notice(failure, { hostedMachine: true, outageMs: HOSTED_STUCK_AFTER_MS }).action?.kind).toBe(`setup`);
        }
    });

    /* NEVER FOR SOMEBODY ELSE'S COMPUTER. A sandbox on the reader's own hardware is unreachable for reasons
     * this browser cannot see or act on — a closed laptop, a paused container, a slow image pull — and the
     * platform has nothing to say about it and nothing to restart. Guessing there would be an alarm about a
     * machine we do not run. */
    it(`leaves a sandbox on the reader's own computer waiting, however long it takes`, () => {
        expect(notice(dead, { hostedMachine: false, outageMs: 60 * HOSTED_STUCK_AFTER_MS }).action).toBeUndefined();
    });
});
