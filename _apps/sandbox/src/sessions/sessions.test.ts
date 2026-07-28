import { expect, test, vi } from "vitest";
import { readWorkspaceSession, searchWorkspaceSessions } from "./sessions.js";

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

// A stored turn as the SDK files it: the assistant's prose and tool_use blocks on one message, their results
// on the synthetic user message that follows.
test("rebuilds the turn's tool cards, settled by their results", async () => {
    getSessionMessages.mockResolvedValue([
        { type: "user", message: { content: "fix the config" } },
        {
            type: "assistant",
            message: {
                content: [
                    { type: "thinking", thinking: "check it first" },
                    { type: "text", text: "Reading the config." },
                    { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/work/app/config.ts" } },
                    { type: "tool_use", id: "t2", name: "Bash", input: { command: "ls" } },
                ],
            },
        },
        {
            type: "user",
            message: {
                content: [
                    { type: "tool_result", tool_use_id: "t1", content: "export const port = 1;" },
                    { type: "tool_result", tool_use_id: "t2", content: "boom", is_error: true },
                ],
            },
        },
        { type: "assistant", message: { content: [{ type: "text", text: "Done." }] } },
    ]);

    const messages = await readWorkspaceSession("/work", "s0");

    // The tool_result-only user message is plumbing, not something the user said — four stored messages, three bubbles.
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "assistant"]);
    expect(messages[0]).toEqual({ role: "user", text: "fix the config" });
    expect(messages[1]?.thinking).toBe("check it first");
    expect(messages[1]?.tools?.map((tool) => [tool.name, tool.category, tool.status])).toEqual([
        ["Read", "read", "completed"],
        ["Bash", "execute", "failed"],
    ]);
    expect(messages[1]?.tools?.[1]?.content).toEqual([{ type: "text", text: "boom" }]);
    // Each stored assistant message is its own bubble, so the closing prose does not merge into the first.
    expect(messages[2]).toEqual({ role: "assistant", text: "Done." });
});

test("a call whose result never arrived stays in progress rather than claiming it finished", async () => {
    getSessionMessages.mockResolvedValue([
        { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "sleep 100" } }] } },
    ]);
    const messages = await readWorkspaceSession("/work", "s0");
    expect(messages[0]?.tools?.[0]?.status).toBe("in_progress");
});

// An archived agent's transcript is keyed by its retired worktree path, which the dir-scoped search (workspace
// root + registered worktrees) no longer reaches — the read falls back to the all-projects search rather than
// reporting a transcript that exists on disk as empty.
test("a session outside the dir scope is found by the all-projects fallback", async () => {
    getSessionMessages.mockImplementation(async (_id: string, options?: { dir?: string }) =>
        options?.dir !== undefined ? [] : [{ type: "user", message: { content: "archived words" } }],
    );
    const messages = await readWorkspaceSession("/work", "s0");
    expect(messages).toEqual([{ role: "user", text: "archived words" }]);
});

// A successful Edit's result is the redundant "file updated" snippet; the card keeps the diff derived from the
// call's own input, exactly as the live stream leaves it.
test("a successful edit keeps its call-time diff instead of the result snippet", async () => {
    getSessionMessages.mockResolvedValue([
        {
            type: "assistant",
            message: {
                content: [{ type: "tool_use", id: "t1", name: "Edit", input: { file_path: "/work/a.ts", old_string: "one", new_string: "two" } }],
            },
        },
        { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "The file has been updated." }] } },
    ]);
    const messages = await readWorkspaceSession("/work", "s0");
    expect(messages[0]?.tools?.[0]).toMatchObject({
        status: "completed",
        content: [{ type: "diff", path: "a.ts", oldText: "one", newText: "two" }],
    });
});
