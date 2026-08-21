import { expect, test } from "vitest";
import { createRequest } from "../agent/agent-requests.js";
import { clearBrowserHelp, closeBrowserSession, listBrowserSessions, openBrowserSession, raiseBrowserHelp } from "./browser-sessions.js";

/* The help-request STATE, without a Chromium: openBrowserSession registers the record from the hook alone (the
 * attach dials a port nothing listens on, and closing the session is what stops it), so everything the /browsers
 * banner renders from (raise, list, clear, and the close-settles-the-waiter guarantee) is assertable here.
 * The full drive-a-real-browser seam stays in browser-sessions.integration.test.ts. */

const open = (sessionId: string, server: string): string => {
    const name = openBrowserSession({ sessionId, server, port: 1 });
    expect(name).toBeDefined();
    return name as string;
};

test("a help request lands on the account's running browser and lists for the banner", async () => {
    const name = open("he1p1111-2222", "reddit-work");
    try {
        // Addressed by account, not by session name: the tool knows which sign-in it is stuck on.
        expect(raiseBrowserHelp("nobody-connected-this", { requestId: "r0", message: "x", requestedAt: 1 })).toBeUndefined();
        expect(raiseBrowserHelp("reddit-work", { requestId: "r1", message: "please solve the captcha", requestedAt: 1 })).toBe(name);

        const listed = listBrowserSessions().find((session) => session.name === name);
        expect(listed?.help).toEqual({ requestId: "r1", message: "please solve the captcha", requestedAt: 1 });

        // Settled by id, so a stale settle can never take down a newer request on the same session.
        clearBrowserHelp("r-not-this-one");
        expect(listBrowserSessions().find((session) => session.name === name)?.help).toBeDefined();
        clearBrowserHelp("r1");
        expect(listBrowserSessions().find((session) => session.name === name)?.help).toBeUndefined();
    } finally {
        await closeBrowserSession(name);
    }
});

/* The browser dying under a parked request must settle it: the parked tool call waits on a PERSON, not on
 * Chromium, so nothing else would ever release it: the turn would sit parked on a banner the close just took
 * down. The settle reads as "not helped", which is the honest account of a browser that closed first. */
test("closing a browser settles its open help request as not-helped", async () => {
    const name = open("he1p3333-4444", "npmjs-main");
    const { id, wait } = createRequest("browser_help", { kind: "browser_help", requestId: "", helped: false, note: "aborted" });
    expect(raiseBrowserHelp("npmjs-main", { requestId: id, message: "type the password", requestedAt: 2 })).toBe(name);

    const settled = wait(new AbortController().signal);
    await closeBrowserSession(name);
    const { reply } = await settled;
    expect(reply.helped).toBe(false);
    expect(reply.note).toContain("closed");
    // And the record's banner state came down with it.
    expect(listBrowserSessions().find((session) => session.name === name)?.help).toBeUndefined();
});
