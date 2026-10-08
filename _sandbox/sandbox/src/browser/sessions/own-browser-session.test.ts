import type { BrowserContext } from "playwright";
import { adoptBrowserSession, browserSessionRunning, closeBrowserSession, idleBrowserSessionNames, listBrowserSessions } from "./browser-sessions.js";

// The person's own window, as the session list carries it, without a Chromium: a context with no pages is all the
// adoption reads, and these questions are about the record, not the page inside it.

const fakeContext = (): BrowserContext => ({ browser: () => null, on: () => undefined, pages: () => [] }) as unknown as BrowserContext;

const NAME = "browser-own-test";

test("an adopted window lists as the person's own, with no agent behind it", async () => {
    adoptBrowserSession({ name: NAME, server: "_own-test", context: fakeContext(), shutdown: async () => {} });
    try {
        const listed = listBrowserSessions().find((session) => session.name === NAME);
        expect(listed).toMatchObject({ own: true, running: true, label: "Your browser" });
        expect(listed?.owner).toBeUndefined();
        expect(browserSessionRunning(NAME)).toBe(true);
    } finally {
        await closeBrowserSession(NAME);
    }
});

// A browser left open on a desktop is still open when its owner comes back; the reaper's clock is for agents' windows.
test("the person's own window is never idle, however long it sits", async () => {
    adoptBrowserSession({ name: NAME, server: "_own-test", context: fakeContext(), shutdown: async () => {} });
    try {
        expect(idleBrowserSessionNames(Date.now() + 24 * 3_600_000, 60_000)).not.toContain(NAME);
    } finally {
        await closeBrowserSession(NAME);
    }
});

// Playwright's close() on an attached browser only disconnects; a window this daemon started is ended by its own hand.
test("closing the person's window ends it through its own shutdown", async () => {
    let shut = 0;
    adoptBrowserSession({
        name: NAME,
        server: "_own-test",
        context: fakeContext(),
        shutdown: async () => {
            shut += 1;
        },
    });
    await closeBrowserSession(NAME);
    expect(shut).toBe(1);
    expect(browserSessionRunning(NAME)).toBe(false);
    expect(listBrowserSessions().find((session) => session.name === NAME)?.running).toBe(false);
});
