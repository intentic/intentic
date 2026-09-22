import { test, expect } from "bun:test";
import {
    clearBrowserHelp,
    closeBrowserSession,
    idleBrowserSessionNames,
    listBrowserSessions,
    openBrowserSession,
    raiseBrowserHelp,
} from "./browser-sessions.js";

// The session's OWN idle clock, without a Chromium: openBrowserSession registers the record from the hook alone and
// stamps activityAt, which is all this question reads. `now` is a parameter precisely so the window can be crossed
// here without waiting ten minutes for it.

const WINDOW_MS = 10 * 60_000;

const open = (sessionId: string, server: string): string => {
    const name = openBrowserSession({ sessionId, server, port: 1 });
    expect(name).toEqual(expect.any(String));
    return name as string;
};

// The measured leak: the reaper's other browser pass closes by OWNER, so a conversation still running turns held a
// Chromium it had finished with for 21 minutes. This pass asks the session instead, and a live owner is no defence.
test("a browser nobody has driven past the window is idle, however busy its conversation is", async () => {
    const name = open("id1e1111-2222", "web");
    try {
        // Read off the record rather than from a clock of our own: the stamp is what the question compares against,
        // and a millisecond between the open and a second Date.now() is enough to move the boundary under us.
        const activityAt = listBrowserSessions().find((session) => session.name === name)?.activityAt;
        expect(activityAt).toEqual(expect.any(Number));
        const stamped = activityAt as number;
        expect(idleBrowserSessionNames(stamped, WINDOW_MS)).not.toContain(name);
        // One millisecond inside the window is still in use; the boundary itself is idle.
        expect(idleBrowserSessionNames(stamped + WINDOW_MS - 1, WINDOW_MS)).not.toContain(name);
        expect(idleBrowserSessionNames(stamped + WINDOW_MS, WINDOW_MS)).toContain(name);
    } finally {
        await closeBrowserSession(name);
    }
});

// Closing this one would answer the owner's pending question by destroying what it is about: the agent is blocked
// BECAUSE nobody has driven the browser, so idleness is the symptom of the wait, not evidence the browser is spare.
test("a browser parked on a help request is never idle", async () => {
    const name = open("id1e3333-4444", "reddit-parked");
    try {
        const openedAt = Date.now();
        expect(raiseBrowserHelp("reddit-parked", { requestId: "idle-r1", message: "solve the captcha", requestedAt: openedAt })).toBe(name);
        expect(idleBrowserSessionNames(openedAt + 10 * WINDOW_MS, WINDOW_MS)).not.toContain(name);
        // Once the person has answered, the ordinary clock applies again.
        clearBrowserHelp("idle-r1");
        expect(idleBrowserSessionNames(openedAt + 10 * WINDOW_MS, WINDOW_MS)).toContain(name);
    } finally {
        await closeBrowserSession(name);
    }
});

// A finished record is retained for the strip to render (RETAIN_FINISHED_MS); naming it here would have the reaper
// close the same browser on every sweep for two hours.
test("a finished browser is not idle, it is gone", async () => {
    const name = open("id1e5555-6666", "web");
    const openedAt = Date.now();
    await closeBrowserSession(name);
    expect(idleBrowserSessionNames(openedAt + 10 * WINDOW_MS, WINDOW_MS)).not.toContain(name);
});
