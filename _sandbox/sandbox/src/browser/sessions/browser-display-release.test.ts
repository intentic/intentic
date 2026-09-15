import { expect, test, vi } from "vitest";

// The X display is shared by every conversation browsing the same account, so the release has to be refcounted by
// server. Spying on display.js is the only way to observe it: releaseDisplay's own effect is killing a process.
const released: string[] = [];
vi.mock("../cast/display.js", () => ({
    ensureDisplay: vi.fn(),
    displayOf: vi.fn(),
    releaseDisplay: (key: string) => {
        released.push(key);
    },
    DISPLAY_WIDTH: 1280,
    DISPLAY_HEIGHT: 880,
}));

const { closeBrowserSession, openBrowserSession } = await import("./browser-sessions.js");

// Returns the record's own name rather than deriving it a second way; a session id that cannot be named is a test bug,
// not a case worth asserting around.
const open = (sessionId: string, server: string, port: number): string => {
    const name = openBrowserSession({ sessionId, server, port });
    if (name === undefined) {
        throw new Error(`openBrowserSession refused the id ${sessionId}`);
    }
    return name;
};

test("a display is released only once the last session on that account has finished", async () => {
    released.length = 0;
    const first = open("11111111-1111-4111-8111-111111111111", "radarsuspam", 40001);
    const second = open("22222222-2222-4222-8222-222222222222", "radarsuspam", 40002);
    const web = open("33333333-3333-4333-8333-333333333333", "web", 40003);

    // A second conversation is still on this account, so its display must stay up.
    await closeBrowserSession(first);
    expect(released).toEqual([]);

    // The last one goes, and now the account's display is nobody's.
    await closeBrowserSession(second);
    expect(released).toEqual(["radarsuspam"]);

    // A different server keeps its own display until its own last session ends.
    await closeBrowserSession(web);
    expect(released).toEqual(["radarsuspam", "web"]);
});

test("closing an already-finished session does not release its display twice", async () => {
    released.length = 0;
    const only = open("44444444-4444-4444-8444-444444444444", "radarsuspam2", 40010);
    await closeBrowserSession(only);
    await closeBrowserSession(only);
    expect(released).toEqual(["radarsuspam2"]);
});
