import {
    clearBrowserHelp,
    closeBrowserSession,
    idleBrowserSessionNames,
    listBrowserSessions,
    openBrowserSession,
    raiseBrowserHelp,
    holdBrowserSession,
    closeBrowserSessionsFor,
} from "./browser-sessions.js";
import { browserSessionHooks } from "./browser-session-hooks.js";

// The session's OWN idle clock, without a Chromium: openBrowserSession registers the record from the hook alone and
// stamps activityAt, which is all this question reads. `now` is a parameter precisely so the window can be crossed
// here without waiting ten minutes for it.

const WINDOW_MS = 10 * 60_000;

test("viewers and in-flight tools hold a browser, and release starts its idle grace again", async () => {
    const name = open("id1e7777-8888", "web");
    try {
        const releaseView = holdBrowserSession(name);
        const releaseTool = holdBrowserSession(name);
        expect(idleBrowserSessionNames(Date.now() + 10 * WINDOW_MS, WINDOW_MS)).not.toContain(name);
        releaseView();
        releaseView();
        expect(idleBrowserSessionNames(Date.now() + 10 * WINDOW_MS, WINDOW_MS)).not.toContain(name);
        releaseTool();
        const last = listBrowserSessions().find((entry) => entry.name === name)!.activityAt;
        expect(idleBrowserSessionNames(last + WINDOW_MS - 1, WINDOW_MS)).not.toContain(name);
        expect(idleBrowserSessionNames(last + WINDOW_MS, WINDOW_MS)).toContain(name);
    } finally {
        await closeBrowserSession(name);
    }
});

test("stopped-owner cleanup preserves viewers, while forced cleanup still closes them", async () => {
    const owner = "idle-view-owner";
    const watched = openBrowserSession({ sessionId: "id1e9999-0000", server: "web", port: 1, owner })!;
    const spare = openBrowserSession({ sessionId: "id1e9999-1111", server: "web", port: 1, owner })!;
    const release = holdBrowserSession(watched);
    try {
        await closeBrowserSessionsFor(owner, true);
        release();
        expect(idleBrowserSessionNames(Date.now() + 10 * WINDOW_MS, WINDOW_MS).filter((name) => name === watched || name === spare)).toEqual([watched]);
        await closeBrowserSessionsFor(owner);
        expect(idleBrowserSessionNames(Date.now() + 10 * WINDOW_MS, WINDOW_MS)).not.toContain(watched);
    } finally {
        release();
        await closeBrowserSessionsFor(owner);
    }
});

test("overlapping browser tools release their holds on success and failure", async () => {
    const hooks = browserSessionHooks({ web: 1 });
    const hook = hooks.PreToolUse[0]!.hooks[0]!;
    const base = { session_id: "id1e2222-9999", transcript_path: "unused", cwd: ".", tool_name: "mcp__web__browser_navigate", tool_input: {} };
    const signal = { signal: new AbortController().signal };
    await hook({ ...base, hook_event_name: "PreToolUse", tool_use_id: "one" }, "one", signal);
    await hook({ ...base, hook_event_name: "PreToolUse", tool_use_id: "two" }, "two", signal);
    const name = open(base.session_id, "web");
    try {
        await hook({ ...base, hook_event_name: "PostToolUseFailure", tool_use_id: "one", error: "navigation failed" }, "one", signal);
        expect(idleBrowserSessionNames(Date.now() + 10 * WINDOW_MS, WINDOW_MS)).not.toContain(name);
        await hook({ ...base, hook_event_name: "PostToolUse", tool_use_id: "two", tool_response: {} }, "two", signal);
        expect(idleBrowserSessionNames(Date.now() + 10 * WINDOW_MS, WINDOW_MS)).toContain(name);
    } finally {
        await closeBrowserSession(name);
    }
});

const open = (sessionId: string, server: string): string => {
    const name = openBrowserSession({ sessionId, server, port: 1 });
    expect(name).toEqual(expect.any(String));
    return name as string;
};

test("an aborted browser tool releases its hold even without a completion hook", async () => {
    const hooks = browserSessionHooks({ web: 1 });
    const controller = new AbortController();
    const input = { session_id: "id1e-aborted", transcript_path: "unused", cwd: ".", tool_name: "mcp__web__browser_navigate", tool_input: {}, hook_event_name: "PreToolUse", tool_use_id: "aborted" } as const;
    await hooks.PreToolUse[0]!.hooks[0]!(input, "aborted", { signal: controller.signal });
    const name = open(input.session_id, "web");
    try {
        expect(idleBrowserSessionNames(Date.now() + 10 * WINDOW_MS, WINDOW_MS)).not.toContain(name);
        controller.abort();
        expect(idleBrowserSessionNames(Date.now() + 10 * WINDOW_MS, WINDOW_MS)).toContain(name);
    } finally {
        await closeBrowserSession(name);
    }
});

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
        expect(raiseBrowserHelp("reddit-parked", { requestId: "idle-r1", message: "solve the captcha", requestedAt: openedAt }, () => {})).toBe(name);
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
