import { describe, expect, it } from "vitest";
import { classifyFailure } from "../composables/sandbox/connection";
import { connectionNotice } from "./connectionNotice";

describe(`connectionNotice`, () => {
    it(`offers nothing to click while an ordinary first connect is in flight`, () => {
        // Nothing is wrong yet. A "Reconnect" button here invites the user to fix what clears itself.
        const notice = connectionNotice(undefined, `laptop`);
        expect(notice.action).toBeUndefined();
        expect(notice.title).toContain(`laptop`);
    });

    it(`sends a never-announced sandbox to setup, not to a reconnect`, () => {
        const notice = connectionNotice(classifyFailure({ unaddressed: true, message: `no address` }), `laptop`);
        expect(notice.action).toBe(`setup`);
    });

    it(`asks for a sign-in on 401 rather than blaming the sandbox`, () => {
        // The sandbox is fine; the browser's token is not. Offering "Reconnect" would point at the wrong thing.
        const notice = connectionNotice(classifyFailure({ status: 401, message: `unauthorized` }), `laptop`);
        expect(notice.action).toBe(`signin`);
        expect(notice.body).toContain(`expired`);
    });

    it(`keeps transient timeout and network failures automatic and non-diagnostic`, () => {
        const timeout = connectionNotice(classifyFailure({ watchdog: true, message: `silent` }), `laptop`);
        const network = connectionNotice(classifyFailure({ message: `failed to fetch` }), `laptop`);
        expect(timeout.title).not.toBe(network.title);
        expect(timeout.body).not.toContain(`heartbeat`);
        expect(timeout.action).toBeUndefined();
        expect(network.action).toBeUndefined();
    });

    it(`keeps a mid-restart daemon actionless`, () => {
        const notice = connectionNotice(classifyFailure({ closed: true, message: `closed` }), `laptop`);
        expect(notice.action).toBeUndefined();
    });

    it(`names the sandbox even when the list hasn't loaded`, () => {
        expect(connectionNotice(undefined, undefined).title).toContain(`your sandbox`);
    });
});
