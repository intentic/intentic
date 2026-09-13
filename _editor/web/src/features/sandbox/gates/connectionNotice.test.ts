import { describe, expect, it } from "vitest";
import { classifyFailure, type ConnectionFailure } from "../live/connection";
import { DETACHED_AFTER_MS } from "../overview/availability";
import { connectionNotice, type ConnectionNoticeInput, HOSTED_STUCK_AFTER_MS, OWN_STUCK_AFTER_MS } from "./connectionNotice";

// The ordinary case every test below varies one fact of: somebody's own computer, freshly unreachable.
const notice = (failure: ConnectionFailure | undefined, over: Partial<ConnectionNoticeInput> = {}) =>
    connectionNotice({ failure, sandboxName: `laptop`, hostedMachine: false, outageMs: 0, ...over });

describe(`connectionNotice`, () => {
    it(`offers nothing to click while an ordinary first connect is in flight`, () => {
        const shown = notice(undefined);
        expect(shown.action).toBeUndefined();
        expect(shown.title).toContain(`laptop`);
    });

    it(`sends a never-announced sandbox to setup, not to a reconnect`, () => {
        expect(notice(classifyFailure({ unaddressed: true, message: `no address` })).action).toEqual({ kind: `setup`, label: `Finish setup` });
    });

    it(`asks for a sign-in on 401 rather than blaming the sandbox`, () => {
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

// A hosted machine that boots and dies leaves the workspace spinning with nothing to press, while the wake reflex
// fires into it forever. Past a minute this gate stops calling it a wait and points at the setup screen instead.
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

    // A watchdog trip and a refused connect are the same fact for a box we run: not answering.
    it(`treats a silent stream and a closed one exactly like a refused connect`, () => {
        for (const failure of [classifyFailure({ watchdog: true, message: `silent` }), classifyFailure({ closed: true, message: `closed` })]) {
            expect(notice(failure, { hostedMachine: true, outageMs: HOSTED_STUCK_AFTER_MS }).action?.kind).toBe(`setup`);
        }
    });

    // Nothing here can tell a closed laptop from a slow pull, so the sentence diagnoses neither — but a minute of
    // silence is itself a fact, and saying nothing about it is what left this screen spinning until the tab closed.
    it(`stops calling a sandbox on the reader's own computer a wait, without guessing why`, () => {
        const shown = notice(dead, { hostedMachine: false, outageMs: OWN_STUCK_AFTER_MS });
        expect(shown.waiting).toBe(false);
        expect(shown.action).toEqual({ kind: `setup`, label: `Check setup` });
        expect(shown.title).toContain(`laptop`);
    });

    it(`still waits out an own-computer restart for the first minute`, () => {
        expect(notice(dead, { hostedMachine: false, outageMs: OWN_STUCK_AFTER_MS - 1 }).waiting).toBe(true);
    });
});

// The edge answered and held no tunnel: the browser's own connection is proven fine, and the box is proven absent.
// The one cause this screen can name on the lane where it used to name nothing.
describe(`a sandbox the edge says is not dialled in`, () => {
    const detached = classifyFailure({ edge: `no-tunnel`, message: `not connected` });

    it(`waits out a restart before saying anything`, () => {
        const shown = notice(detached, { outageMs: DETACHED_AFTER_MS - 1 });
        expect(shown.waiting).toBe(true);
        expect(shown.action).toBeUndefined();
    });

    it(`says the box is not connected, and that the reader's network is not the problem`, () => {
        const shown = notice(detached, { outageMs: DETACHED_AFTER_MS });
        expect(shown.waiting).toBe(false);
        expect(shown.title).toBe(`"laptop" isn't connected`);
        expect(shown.action).toEqual({ kind: `setup`, label: `Check setup` });
    });

    // It is named sooner than the plain silence below it, because it is established rather than merely elapsed.
    it(`beats the generic stuck wording on both lanes`, () => {
        for (const hostedMachine of [true, false]) {
            expect(notice(detached, { hostedMachine, outageMs: DETACHED_AFTER_MS }).title).toBe(`"laptop" isn't connected`);
        }
    });
});

// The two certain endings. Neither may be inferred from silence, and neither leaves a spinner up.
describe(`a sandbox that is actually gone`, () => {
    it(`says the container was deleted, and names the machine that deleted it`, () => {
        const shown = notice(classifyFailure({ unaddressed: true, message: `no address` }), { removed: true, removedBy: `radarsu-rog` });
        expect(shown.title).toBe(`"laptop" was removed`);
        expect(shown.body).toContain(`radarsu-rog`);
        expect(shown.waiting).toBe(false);
        expect(shown.action).toEqual({ kind: `setup`, label: `Set it up again` });
    });

    it(`still says it when the remover could not name itself`, () => {
        expect(notice(classifyFailure({ message: `failed to fetch` }), { removed: true }).title).toBe(`"laptop" was removed`);
    });

    it(`outranks every waiting arm, at any age, on either lane`, () => {
        const shown = notice(classifyFailure({ message: `failed to fetch` }), { removed: true, hostedMachine: true, hoursSpent: true, owner: true });
        expect(shown.title).toBe(`"laptop" was removed`);
    });

    it(`says a deleted sandbox no longer exists, with nothing to press and nothing to wait for`, () => {
        const shown = notice(classifyFailure({ edge: `unknown-sandbox`, message: `unknown` }));
        expect(shown.title).toBe(`"laptop" no longer exists`);
        expect(shown.waiting).toBe(false);
        expect(shown.action).toBeUndefined();
    });
});

// The platform refused the wake (PAYMENT_REQUIRED), not a wait, said at once instead of after the minute. The
// owner is offered the plan; a guest is told whose hours they are.
describe(`a hosted machine whose owner's free hours are spent`, () => {
    const asleep = classifyFailure({ message: `failed to fetch` });

    it(`says so at once, before any wait, and offers the plan to the owner`, () => {
        const shown = notice(asleep, { hostedMachine: true, hoursSpent: true, owner: true, outageMs: 0 });
        expect(shown.title).toBe(`"laptop" has used its free hours for this month`);
        expect(shown.action).toEqual({ kind: `billing`, label: `See the plan` });
    });

    it(`outranks the stuck-machine door once the minute has passed`, () => {
        expect(notice(asleep, { hostedMachine: true, hoursSpent: true, owner: true, outageMs: 60 * HOSTED_STUCK_AFTER_MS }).action?.kind).toBe(`billing`);
    });

    it(`sells a guest nothing, and names whose hours they are`, () => {
        const shown = notice(asleep, { hostedMachine: true, hoursSpent: true, owner: false });
        expect(shown.action).toBeUndefined();
        expect(shown.body).toContain(`owner`);
    });

    it(`means nothing for a sandbox on the reader's own computer`, () => {
        expect(notice(asleep, { hostedMachine: false, hoursSpent: true, owner: true }).action).toBeUndefined();
    });
});
