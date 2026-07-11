import { expect, test, vi } from "vitest";
import { searchWorkspaceSessions } from "./sessions.js";

// Fake the SDK store the sessions module reads through. `listSessions` is newest-first; `getSessionMessages`
// returns Anthropic-shaped turns (content is a string here for brevity).
const { listSessions, getSessionMessages, getSessionInfo } = vi.hoisted(() => ({
    listSessions: vi.fn(),
    getSessionMessages: vi.fn(),
    getSessionInfo: vi.fn(),
}));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ listSessions, getSessionMessages, getSessionInfo }));

// N sessions newest-first: s0..s{n-1}. Titles are "chat 0".. so a title needle can target one precisely.
const seed = (n: number): void => {
    listSessions.mockResolvedValue(Array.from({ length: n }, (_, i) => ({ sessionId: `s${i}`, customTitle: `chat ${i}`, lastModified: n - i })));
    // Each transcript holds one user turn whose text is "body <id>", so a content needle can target one session.
    getSessionMessages.mockImplementation(async (id: string) => [{ type: "user", message: { content: `body ${id}` } }]);
};

test("title match returns without reading the transcript", async () => {
    seed(3);
    getSessionMessages.mockClear();
    const hits = await searchWorkspaceSessions("/work", "chat 1");
    expect(hits.map((s) => s.id)).toEqual(["s1"]);
    // s1 matched by title; the other two are read for content, s1 is not.
    expect(getSessionMessages).not.toHaveBeenCalledWith("s1", expect.anything());
});

test("content match within the recent-N window is found", async () => {
    seed(3);
    const hits = await searchWorkspaceSessions("/work", "body s2", 10);
    expect(hits.map((s) => s.id)).toEqual(["s2"]);
});

test("a content match beyond the content limit is not returned or even read", async () => {
    seed(12);
    getSessionMessages.mockClear();
    // "body s11" lives in the 12th-newest session; with contentLimit 10 it's outside the scanned slice.
    const hits = await searchWorkspaceSessions("/work", "body s11", 10);
    expect(hits).toEqual([]);
    expect(getSessionMessages).not.toHaveBeenCalledWith("s11", expect.anything());
});
