import { expect, test, vi } from "vitest";
import { withRuntimeHistory } from "../agent/runtime-history.js";
import { conversationSessionId, listWorkspaceSessions, readConversationSession, readWorkspaceSession, searchWorkspaceSessions } from "./sessions.js";

// Fake the SDK store the sessions module reads through. `listSessions` is newest-first; `getSessionMessages`
// returns Anthropic-shaped turns (content is a string here for brevity).
const { listSessions, getSessionMessages, getSessionInfo } = vi.hoisted(() => ({
    listSessions: vi.fn(),
    getSessionMessages: vi.fn(),
    getSessionInfo: vi.fn(),
}));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ listSessions, getSessionMessages, getSessionInfo }));

/* N sessions newest-first: <tag>0..<tag>{n-1}. Titles are "chat 0".. so a title needle can target one
 * precisely, and each transcript holds one user turn reading "body <id>" so a prompt needle can too.
 *
 * The `tag` is not decoration: the prompt index caches a session's prompts by id for the life of the process
 * (they are append-only, so nothing invalidates them), which means two tests sharing an id would share a
 * transcript. Each test seeds its own namespace instead of the module exporting a reset nothing in production
 * would ever call.
 */
const seed = (tag: string, n: number): void => {
    listSessions.mockResolvedValue(Array.from({ length: n }, (_, i) => ({ sessionId: `${tag}${i}`, customTitle: `chat ${i}`, lastModified: n - i })));
    getSessionMessages.mockImplementation(async (id: string) => [{ type: "user", message: { content: `body ${id}` } }]);
};

test("title match returns without reading the transcript", async () => {
    seed("t", 3);
    getSessionMessages.mockClear();
    const hits = await searchWorkspaceSessions("/work", "chat 1");
    expect(hits.map((s) => s.id)).toEqual(["t1"]);
    // t1 matched by title; the other two are read for prompts, t1 is not.
    expect(getSessionMessages).not.toHaveBeenCalledWith("t1", expect.anything());
    // …and a title match carries no snippet: the row already shows the title it matched on.
    expect(hits[0]?.snippet).toBeUndefined();
});

test("a prompt match is found and reports the line it hit", async () => {
    seed("p", 3);
    const hits = await searchWorkspaceSessions("/work", "body p2");
    expect(hits.map((s) => s.id)).toEqual(["p2"]);
    expect(hits[0]?.snippet).toBe("body p2");
});

// The scan used to read transcripts for the ten most recent sessions only, because each read rebuilt the whole
// transcript. It reads the user half alone now, and holds it — so recall no longer falls off a cliff at the
// tenth chat, which is precisely where "the one I'm looking for" tends to live.
test("a prompt match past the tenth-newest session is still found", async () => {
    seed("w", 12);
    const hits = await searchWorkspaceSessions("/work", "body w11");
    expect(hits.map((s) => s.id)).toEqual(["w11"]);
});

/* The whole point of the rule: YOUR words, not the agent's. On a fleet where every transcript names most of
 * the workspace's identifiers, matching assistant prose or tool output returns nearly everything. */
test("assistant prose and tool output are not matches", async () => {
    listSessions.mockResolvedValue([{ sessionId: "r0", customTitle: "chat", lastModified: 1 }]);
    getSessionMessages.mockResolvedValue([
        { type: "user", message: { content: "check the config" } },
        { type: "assistant", message: { content: [{ type: "text", text: "landAgent lives in laneDrop.ts" }] } },
        { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "grep found landAgent 214 times" }] } },
    ]);
    expect(await searchWorkspaceSessions("/work", "landAgent")).toEqual([]);
    expect((await searchWorkspaceSessions("/work", "check the config")).map((s) => s.id)).toEqual(["r0"]);
});

// The daemon staples a readiness/delegation preamble on the front of a prompt and an attachment note on the
// end (agent.routes.ts). Both are stored verbatim, and both are protocol — matching them would make
// "dependencies" or "attached" hit every agent that ever ran with a setup notice.
test("the injected preamble and attachment note are not searchable text", async () => {
    const notice = "Dependencies are NOT installed for the following projects, so their type-checks, linters and tests cannot work yet";
    listSessions.mockResolvedValue([{ sessionId: "i0", customTitle: "chat", lastModified: 1 }]);
    getSessionMessages.mockResolvedValue([
        {
            type: "user",
            message: {
                content: `${notice}\n\n---\n\nrename the lane\n\nThe user attached these files — read them with the Read tool as needed:\n- /work/shot.png`,
            },
        },
    ]);
    expect(await searchWorkspaceSessions("/work", "Dependencies are NOT")).toEqual([]);
    expect(await searchWorkspaceSessions("/work", "shot.png")).toEqual([]);
    expect((await searchWorkspaceSessions("/work", "rename the lane")).map((s) => s.id)).toEqual(["i0"]);
});

// A snippet is EVIDENCE, so it has to carry the hit and enough around it to read — windowed, not truncated
// from the front, and with the newlines collapsed so one match can't push the rest of a lane off screen.
test("a long prompt is windowed around the hit rather than cut from the start", async () => {
    const long = `${"filler ".repeat(40)}\n\nthe landAgent bug\n\n${"more ".repeat(40)}`;
    listSessions.mockResolvedValue([{ sessionId: "n0", customTitle: "chat", lastModified: 1 }]);
    getSessionMessages.mockResolvedValue([{ type: "user", message: { content: long } }]);
    const snippet = (await searchWorkspaceSessions("/work", "landagent"))[0]?.snippet ?? "";
    expect(snippet).toContain("landAgent");
    expect(snippet).not.toContain("\n");
    expect(snippet.startsWith("…")).toBe(true);
    expect(snippet.endsWith("…")).toBe(true);
    expect(snippet.length).toBeLessThanOrEqual(122);
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

// The daemon prepends readiness/delegation notes to the prompt it files (agent.routes.ts); a redrawn tab must
// show what the user typed, not the protocol around it — the original complaint was the "Dependencies are NOT
// installed" note stapled onto old messages after every refresh.
test("restore strips an injected turn preamble from the user's bubble", async () => {
    const notice = [
        "Dependencies are NOT installed for the following projects, so their type-checks, linters and tests cannot work yet",
        "(a dropped project arrives without them on purpose):",
        "- intentic: run `pnpm install` there first.",
    ].join("\n");
    getSessionMessages.mockResolvedValue([{ type: "user", message: { content: `${notice}\n\n---\n\nfix the config` } }]);
    const messages = await readWorkspaceSession("/work", "s0");
    expect(messages).toEqual([{ role: "user", text: "fix the config" }]);
});

test("a history-list title falling back to firstPrompt names the chat, not the injected notice", async () => {
    const first = [
        "Dependencies are NOT installed for the following projects, so their type-checks, linters and tests cannot work yet",
        "(a dropped project arrives without them on purpose):",
        "- intentic: run `pnpm install` there first.",
        "",
        "---",
        "",
        "fix the config",
    ].join("\n");
    listSessions.mockResolvedValue([{ sessionId: "s0", firstPrompt: first, lastModified: 1 }]);
    const sessions = await listWorkspaceSessions("/work");
    expect(sessions[0]?.title).toBe("fix the config");
});

test("a replacement runtime session keeps the conversation's original user title", async () => {
    listSessions.mockResolvedValue([
        {
            sessionId: "replacement",
            firstPrompt: withRuntimeHistory("Continue.", [
                { role: "user", text: "Investigate the blank chat." },
                { role: "assistant", text: "I will trace hydration." },
            ]),
            lastModified: 1,
        },
    ]);
    expect((await listWorkspaceSessions("/work"))[0]?.title).toBe("Investigate the blank chat.");
});

test("resolves the newest SDK session scoped exactly to one conversation worktree", async () => {
    listSessions.mockResolvedValue([{ sessionId: "replacement", lastModified: 2 }]);

    expect(await conversationSessionId("/history/worktrees/conversation-1")).toBe("replacement");
    expect(listSessions).toHaveBeenCalledWith({ dir: "/history/worktrees/conversation-1", includeWorktrees: false, limit: 1 });
});

test("returns no conversation transcript before that worktree has an SDK session", async () => {
    listSessions.mockResolvedValue([]);
    expect(await readConversationSession("/history/worktrees/new-agent")).toBeUndefined();
});

test("runtime-handoff search indexes prior user prompts but not assistant prose or protocol", async () => {
    listSessions.mockResolvedValue([{ sessionId: "handoff-search", customTitle: "chat", lastModified: 1 }]);
    getSessionMessages.mockResolvedValue([
        {
            type: "user",
            message: {
                content: withRuntimeHistory("Continue.", [
                    { role: "user", text: "Investigate the blank chat." },
                    { role: "assistant", text: "I will inspect replayStoredSession." },
                ]),
            },
        },
    ]);

    expect((await searchWorkspaceSessions("/work", "blank chat")).map((session) => session.id)).toEqual(["handoff-search"]);
    expect(await searchWorkspaceSessions("/work", "replayStoredSession")).toEqual([]);
    expect(await searchWorkspaceSessions("/work", "another AI runtime")).toEqual([]);
});

test("restores runtime-handoff history as ordinary bubbles", async () => {
    const history = [
        { role: "user" as const, text: "Investigate the blank chat." },
        { role: "assistant" as const, text: "I will trace hydration." },
        { role: "user" as const, text: "What model are you?" },
    ];
    getSessionMessages.mockResolvedValue([
        { type: "user", message: { content: withRuntimeHistory("Continue.", history) } },
        { type: "assistant", message: { content: [{ type: "text", text: "Continuing now." }] } },
    ]);

    expect(await readWorkspaceSession("/history/worktrees/conversation-1", "replacement")).toEqual([
        ...history,
        { role: "user", text: "Continue." },
        { role: "assistant", text: "Continuing now." },
    ]);
});
