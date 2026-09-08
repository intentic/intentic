import { WORKSPACE_ROOT } from "@intentic/constants";
import { RESUME_NOTES, withResumeNote } from "@intentic/sandbox-contract";
import { expect, test, vi } from "vitest";
import { withRuntimeHistory } from "../agent/providers/runtime-history.js";
import { createRecentSessions, listWorkspaceSessions, readWorkspaceSession, readWorkspaceSessionTail, searchWorkspaceSessions } from "./sessions.js";
import { IN_MEMORY, openSearchIndex } from "./search-index.js";
import { readSessionLines } from "./transcript-search.js";

// Fakes the SDK store: `listSessions` is newest-first, `getSessionMessages` returns Anthropic-shaped turns.
const { listSessions, getSessionMessages, getSessionInfo } = vi.hoisted(() => ({
    listSessions: vi.fn(),
    getSessionMessages: vi.fn(),
    getSessionInfo: vi.fn(),
}));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ listSessions, getSessionMessages, getSessionInfo }));

// Seeds `n` sessions newest-first as `<tag>0..<tag>{n-1}`, titled "chat N" and bodied "body <id>" so a query can target
// one precisely. `tag` namespaces each test's session ids.
const seed = (tag: string, n: number): void => {
    listSessions.mockResolvedValue(Array.from({ length: n }, (_, i) => ({ sessionId: `${tag}${i}`, customTitle: `chat ${i}`, lastModified: n - i })));
    getSessionMessages.mockImplementation(async (id: string) => [{ type: "user", message: { content: `body ${id}` } }]);
};

// Mirrors production's two steps: backfill reads the SDK store into the index, then search reads only the index. Fresh
// instances per call, so no test inherits another's rows via the list's short TTL.
const indexed = async (dir: string) => {
    const index = openSearchIndex(IN_MEMORY);
    const recent = createRecentSessions(dir);
    for (const session of await recent()) {
        index.put(session.id, "session", String(session.updatedAt), await readSessionLines(dir, session.id));
    }
    return { index, recent };
};

const searchSessions = async (dir: string, query: string, caseSensitive: boolean) => {
    const { index, recent } = await indexed(dir);
    return searchWorkspaceSessions(recent, query, caseSensitive, async (...args) => index.search(...args));
};

test("a title match reads no session file at all", async () => {
    seed("t", 3);
    const { index, recent } = await indexed(WORKSPACE_ROOT);
    getSessionMessages.mockClear();
    const hits = await searchWorkspaceSessions(recent, "chat 1", false, async (...args) => index.search(...args));
    expect(hits.map((s) => s.id)).toEqual(["t1"]);
    expect(getSessionMessages).not.toHaveBeenCalled();
    expect(hits[0]?.snippet).toBeUndefined();
});

test("a prompt match is found and reports the line it hit, and whose it was", async () => {
    seed("p", 3);
    const hits = await searchSessions(WORKSPACE_ROOT, "body p2", false);
    expect(hits.map((s) => s.id)).toEqual(["p2"]);
    expect(hits[0]?.snippet).toEqual({ text: "body p2", speaker: "user" });
});

// recent() caches its list for 400ms, sharing summary objects across queries in that window; a written snippet leaked
// into the next one. Both queries here share one `recent()` on purpose, since fresh-per-call hides this.
test("a snippet from one query never rides along on the next", async () => {
    seed("p", 3);
    const { index, recent } = await indexed(WORKSPACE_ROOT);
    const said = async (...args: Parameters<typeof index.search>) => index.search(...args);

    const first = await searchWorkspaceSessions(recent, "body p1", false, said);
    expect(first[0]?.snippet).toEqual({ text: "body p1", speaker: "user" });

    const byTitle = await searchWorkspaceSessions(recent, "chat 1", false, said);
    expect(byTitle.map((session) => session.id)).toEqual(["p1"]);
    expect(byTitle[0]?.snippet).toBeUndefined();

    const second = await searchWorkspaceSessions(recent, "body p2", false, said);
    expect(second.map((session) => session.id)).toEqual(["p2"]);
    expect(second[0]?.snippet).toEqual({ text: "body p2", speaker: "user" });
});

test("a prompt match past the tenth-newest session is still found", async () => {
    seed("w", 12);
    const hits = await searchSessions(WORKSPACE_ROOT, "body w11", false);
    expect(hits.map((s) => s.id)).toEqual(["w11"]);
});

test("assistant prose matches as the agent's; thinking and tool output never match", async () => {
    listSessions.mockResolvedValue([{ sessionId: "r0", customTitle: "chat", lastModified: 1 }]);
    getSessionMessages.mockResolvedValue([
        { type: "user", message: { content: "check the config" } },
        {
            type: "assistant",
            message: {
                content: [
                    { type: "thinking", thinking: "the caller might be readWorkspaceSession" },
                    { type: "text", text: "landAgent lives in laneDrop.ts" },
                    { type: "tool_use", id: "t1", name: "Bash", input: { command: "rg landAgent" } },
                ],
            },
        },
        { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "grep found landAgent 214 times" }] } },
    ]);
    expect((await searchSessions("/work", "landAgent", false)).map((s) => s.snippet)).toEqual([
        { text: "landAgent lives in laneDrop.ts", speaker: "agent" },
    ]);
    expect((await searchSessions("/work", "check the config", false)).map((s) => s.id)).toEqual(["r0"]);
    expect(await searchSessions("/work", "readWorkspaceSession", false)).toEqual([]);
    expect(await searchSessions("/work", "214 times", false)).toEqual([]);
});

test("the user's own words are the snippet when both sides said the term", async () => {
    listSessions.mockResolvedValue([{ sessionId: "b0", customTitle: "chat", lastModified: 1 }]);
    getSessionMessages.mockResolvedValue([
        { type: "assistant", message: { content: [{ type: "text", text: "the lane drop is in laneDrop.ts" }] } },
        { type: "user", message: { content: "explain the lane drop" } },
    ]);
    expect((await searchSessions("/work", "lane drop", false))[0]?.snippet).toEqual({ text: "explain the lane drop", speaker: "user" });
});

// The daemon staples a readiness preamble onto a prompt's front and an attachment note onto its end (agent.routes.ts);
// both are protocol, so matching them would make "dependencies" or "attached" hit almost every session.
test("the injected preamble and attachment note are not searchable text", async () => {
    const notice = "Dependencies are NOT installed for the following projects, so their type-checks, linters and tests cannot work yet";
    listSessions.mockResolvedValue([{ sessionId: "i0", customTitle: "chat", lastModified: 1 }]);
    getSessionMessages.mockResolvedValue([
        {
            type: "user",
            message: {
                content: `${notice}\n\n---\n\nrename the lane\n\nThe user attached these files: read them with the Read tool as needed:\n- /work/shot.png`,
            },
        },
    ]);
    expect(await searchSessions("/work", "Dependencies are NOT", false)).toEqual([]);
    expect(await searchSessions("/work", "shot.png", false)).toEqual([]);
    expect((await searchSessions("/work", "rename the lane", false)).map((s) => s.id)).toEqual(["i0"]);
});

// The same case-sensitivity switch as the board's cards, since these rows are listed under them; a mismatch would be
// one search field with two rules.
test("match case narrows both the title and the transcript", async () => {
    listSessions.mockResolvedValue([{ sessionId: "c0", customTitle: "FROM the top", lastModified: 2 }]);
    getSessionMessages.mockResolvedValue([{ type: "user", message: { content: "the landAgent bug" } }]);
    expect((await searchSessions(WORKSPACE_ROOT, "from the top", false)).map((s) => s.id)).toEqual(["c0"]);
    expect(await searchSessions(WORKSPACE_ROOT, "from the top", true)).toEqual([]);
    expect((await searchSessions(WORKSPACE_ROOT, "FROM the top", true)).map((s) => s.id)).toEqual(["c0"]);
    expect(await searchSessions(WORKSPACE_ROOT, "landagent", true)).toEqual([]);
    expect((await searchSessions(WORKSPACE_ROOT, "landAgent", true))[0]?.snippet).toEqual({
        text: "the landAgent bug",
        speaker: "user",
    });
});

// Windowed around the hit, not truncated from the front, with newlines collapsed so one match can't push a lane's whole
// line off screen.
test("a long prompt is windowed around the hit rather than cut from the start", async () => {
    const long = `${"filler ".repeat(40)}\n\nthe landAgent bug\n\n${"more ".repeat(40)}`;
    listSessions.mockResolvedValue([{ sessionId: "n0", customTitle: "chat", lastModified: 1 }]);
    getSessionMessages.mockResolvedValue([{ type: "user", message: { content: long } }]);
    const snippet = (await searchSessions(WORKSPACE_ROOT, "landagent", false))[0]?.snippet?.text ?? "";
    expect(snippet).toContain("landAgent");
    expect(snippet).not.toContain("\n");
    expect(snippet.startsWith("…")).toBe(true);
    expect(snippet.endsWith("…")).toBe(true);
    expect(snippet.length).toBeLessThanOrEqual(122);
});

// The SDK stores a turn's prose/tool_use blocks on one assistant message, with their results on the synthetic user
// message that follows.
test("rebuilds the turn's tool cards, settled by their results", async () => {
    getSessionMessages.mockResolvedValue([
        { type: "user", message: { content: "fix the config" } },
        {
            type: "assistant",
            message: {
                content: [
                    { type: "thinking", thinking: "check it first" },
                    { type: "text", text: "Reading the config." },
                    { type: "tool_use", id: "t1", name: "Read", input: { file_path: `${WORKSPACE_ROOT}/app/config.ts` } },
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

    const messages = await readWorkspaceSession(WORKSPACE_ROOT, "s0");

    expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "assistant"]);
    expect(messages[0]).toEqual({ role: "user", text: "fix the config" });
    expect(messages[1]).toEqual({ role: "assistant", text: "Reading the config.", thinking: "check it first" });
    expect(messages[2]?.text).toBe("Done.");
    expect(messages[2]?.tools?.map((tool) => [tool.name, tool.category, tool.status])).toEqual([
        ["Read", "read", "completed"],
        ["Bash", "execute", "failed"],
    ]);
    expect(messages[2]?.tools?.[1]?.content).toEqual([{ type: "text", text: "boom" }]);
});

test("rebuilds task checklist from TaskCreate and TaskUpdate tool calls rather than emitting tool cards", async () => {
    getSessionMessages.mockResolvedValue([
        { type: "user", message: { content: "refactor the code" } },
        {
            type: "assistant",
            message: {
                content: [
                    { type: "text", text: "Planning work." },
                    { type: "tool_use", id: "tc1", name: "TaskCreate", input: { subject: "Step 1", activeForm: "Doing step 1" } },
                ],
            },
        },
        {
            type: "user",
            message: {
                content: [{ type: "tool_result", tool_use_id: "tc1", content: "Task #1 created successfully: Step 1" }],
            },
        },
        {
            type: "assistant",
            message: {
                content: [
                    { type: "tool_use", id: "tu1", name: "TaskUpdate", input: { taskId: "1", status: "in_progress" } },
                    { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/work/config.ts" } },
                ],
            },
        },
        {
            type: "user",
            message: {
                content: [{ type: "tool_result", tool_use_id: "t1", content: "export const ok = true;" }],
            },
        },
    ]);

    const messages = await readWorkspaceSession(WORKSPACE_ROOT, "s0");
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "assistant"]);
    expect(messages[1]).toEqual({ role: "assistant", text: "Planning work." });
    expect(messages[2]?.todos).toEqual([{ content: "Step 1", status: "in_progress", activeForm: "Doing step 1" }]);
    expect(messages[2]?.tools?.map((tool) => tool.name)).toEqual(["Read"]);
});

// The store never saw the live `question` frame or its reply; the card is rebuilt purely from the ask tool's call (the
// questions) and result (the picks), placed one frame ahead of the call, closing the bubble the prose opened.
test("rebuilds the question a turn asked, and the picks that answered it, from the ask tool's call", async () => {
    const questions = [
        {
            question: "Which?",
            header: "Pick",
            multiSelect: true,
            options: [
                { label: "A", description: "a" },
                { label: "B", description: "b" },
            ],
        },
    ];
    getSessionMessages.mockResolvedValue([
        { type: "user", message: { content: "choose" } },
        {
            type: "assistant",
            message: {
                content: [
                    { type: "text", text: "Two ways." },
                    { type: "tool_use", id: "ask-1", name: "mcp__ui__ask", input: { questions } },
                ],
            },
        },
        { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "ask-1", content: "The user answered:\n- Pick: A, B" }] } },
        { type: "assistant", message: { content: [{ type: "text", text: "Both it is." }] } },
    ]);

    const messages = await readWorkspaceSession(WORKSPACE_ROOT, "s0");

    expect(messages.map((message) => [message.role, message.text])).toEqual([
        ["user", "choose"],
        ["assistant", "Two ways."],
        ["assistant", ""],
        ["assistant", "Both it is."],
    ]);
    expect(messages[2]?.question).toEqual({ requestId: "ask-1", questions, status: "answered", answers: { "Which?": ["A", "B"] } });
    expect(messages[3]?.tools?.map((tool) => [tool.name, tool.status])).toEqual([["mcp__ui__ask", "completed"]]);
});

test("reads a dismissed question back as cancelled, and one with no result as unanswered", async () => {
    const questions = [{ question: "Which?", header: "Pick", multiSelect: false, options: [{ label: "A", description: "a" }] }];
    const dismissed =
        "The user dismissed the questions without answering and stopped the turn. STOP what you are doing and wait for them to say how to proceed.";
    getSessionMessages.mockResolvedValue([
        { type: "user", message: { content: "choose" } },
        { type: "assistant", message: { content: [{ type: "tool_use", id: "ask-1", name: "AskUserQuestion", input: { questions } }] } },
        { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "ask-1", content: dismissed }] } },
        { type: "assistant", message: { content: [{ type: "tool_use", id: "ask-2", name: "AskUserQuestion", input: { questions } }] } },
    ]);

    const messages = await readWorkspaceSession(WORKSPACE_ROOT, "s0");

    const asked = messages.flatMap((message) => (message.question === undefined ? [] : [message.question]));
    expect(asked.map((question) => question.status)).toEqual(["cancelled", "pending"]);
    expect(messages.at(-1)?.tools?.[0]?.status).toBe("in_progress");
});

// The SDK files a fresh assistant message around every content block, so three calls between two sentences are stored
// as three lone tool_use messages, each followed by its own tool_result message.
test("calls stored one per assistant message restore as one run, not one bubble each", async () => {
    getSessionMessages.mockResolvedValue([
        { type: "user", message: { content: "plan the work" } },
        { type: "assistant", message: { content: [{ type: "thinking", thinking: "look around first" }] } },
        ...["t1", "t2", "t3"].flatMap((id) => [
            { type: "assistant", message: { content: [{ type: "tool_use", id, name: "Bash", input: { command: `echo ${id}` } }] } },
            { type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: id }] } },
        ]),
        { type: "assistant", message: { content: [{ type: "text", text: "Found it." }] } },
    ]);

    const messages = await readWorkspaceSession(WORKSPACE_ROOT, "s0");

    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(messages[1]?.tools?.map((tool) => tool.status)).toEqual(["completed", "completed", "completed"]);
    expect(messages[1]?.text).toBe("Found it.");
    expect(messages[1]?.thinking).toBe("look around first");
});

// The provider's store keeps the daemon's resent prompt verbatim (note and all), so a re-run reads back as the same
// message twice unless folded into an interruption, matching the daemon's own record.
test("a re-run in the provider's store reads as the interruption, not as the message twice", async () => {
    getSessionMessages.mockResolvedValue([
        { type: "user", message: { content: "ship the parser" } },
        { type: "assistant", message: { content: [{ type: "text", text: "on it" }] } },
        { type: "user", message: { content: withResumeNote("ship the parser", RESUME_NOTES.auth) } },
        { type: "assistant", message: { content: [{ type: "text", text: "picking back up" }] } },
    ]);
    const messages = await readWorkspaceSession(WORKSPACE_ROOT, "s0");
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "notice", "assistant"]);
    expect(messages[2]?.text).toMatch(/Claude/i);
});

// Exists for the boot pass recovering a turn the daemon died under; returning more than the last turn would duplicate
// turns the record already holds.
test("the tail is the last turn alone, not the session it sits at the end of", async () => {
    getSessionMessages.mockResolvedValue([
        { type: "user", message: { content: "ship the parser" } },
        { type: "assistant", message: { content: [{ type: "text", text: "shipped" }] } },
        { type: "user", message: { content: "now the printer" } },
        { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "pnpm test" } }] } },
    ]);
    const messages = await readWorkspaceSessionTail(WORKSPACE_ROOT, "s0");
    expect(messages.map((message) => message.text)).toEqual(["now the printer", ""]);
    expect(messages[1]?.tools?.[0]).toMatchObject({ name: "Bash", status: "in_progress" });
});

test("a tool result does not open a turn, so the tail keeps the calls that preceded it", async () => {
    getSessionMessages.mockResolvedValue([
        { type: "user", message: { content: "audit the rail" } },
        { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: `${WORKSPACE_ROOT}/a.ts` } }] } },
        { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "export const a = 1;" }] } },
        { type: "assistant", message: { content: [{ type: "text", text: "read it" }] } },
    ]);
    const messages = await readWorkspaceSessionTail(WORKSPACE_ROOT, "s0");
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(messages[0]?.text).toBe("audit the rail");
    expect(messages[1]?.tools?.[0]).toMatchObject({ name: "Read", status: "completed" });
});

// A resume note becomes a muted line with no user row; that line is still a turn boundary, so the split must be read
// off the stored messages, not the restored ones, where it looks like any other notice.
test("a re-run's resume note opens the tail, so the turn it replaced is not recovered twice", async () => {
    getSessionMessages.mockResolvedValue([
        { type: "user", message: { content: "ship the parser" } },
        { type: "assistant", message: { content: [{ type: "text", text: "on it" }] } },
        { type: "user", message: { content: withResumeNote("ship the parser", RESUME_NOTES.outage) } },
        { type: "assistant", message: { content: [{ type: "text", text: "picking back up" }] } },
    ]);
    const messages = await readWorkspaceSessionTail(WORKSPACE_ROOT, "s0");
    expect(messages.map((message) => message.role)).toEqual(["notice", "assistant"]);
    expect(messages[1]?.text).toBe("picking back up");
});

test("a session holding one unfinished turn is entirely tail", async () => {
    getSessionMessages.mockResolvedValue([
        { type: "user", message: { content: "audit the rail" } },
        { type: "assistant", message: { content: [{ type: "text", text: "reading it now" }] } },
    ]);
    expect(await readWorkspaceSessionTail(WORKSPACE_ROOT, "s0")).toEqual([
        { role: "user", text: "audit the rail" },
        { role: "assistant", text: "reading it now" },
    ]);
});

test("a call whose result never arrived stays in progress rather than claiming it finished", async () => {
    getSessionMessages.mockResolvedValue([
        { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "sleep 100" } }] } },
    ]);
    const messages = await readWorkspaceSession(WORKSPACE_ROOT, "s0");
    expect(messages[0]?.tools?.[0]?.status).toBe("in_progress");
});

// An archived agent's transcript is keyed by a retired worktree path the dir-scoped search no longer reaches, so the
// read falls back to an all-projects search instead of reporting it empty.
test("a session outside the dir scope is found by the all-projects fallback", async () => {
    getSessionMessages.mockImplementation(async (_id: string, options?: { dir?: string }) =>
        options?.dir !== undefined ? [] : [{ type: "user", message: { content: "archived words" } }],
    );
    const messages = await readWorkspaceSession(WORKSPACE_ROOT, "s0");
    expect(messages).toEqual([{ role: "user", text: "archived words" }]);
});

// A successful Edit's result is just the redundant "file updated" confirmation; the diff comes from the call's own
// input instead.
test("a successful edit keeps its call-time diff instead of the result snippet", async () => {
    getSessionMessages.mockResolvedValue([
        {
            type: "assistant",
            message: {
                content: [
                    {
                        type: "tool_use",
                        id: "t1",
                        name: "Edit",
                        input: { file_path: `${WORKSPACE_ROOT}/a.ts`, old_string: "one", new_string: "two" },
                    },
                ],
            },
        },
        { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "The file has been updated." }] } },
    ]);
    const messages = await readWorkspaceSession(WORKSPACE_ROOT, "s0");
    expect(messages[0]?.tools?.[0]).toMatchObject({
        status: "completed",
        content: [{ type: "diff", path: "a.ts", oldText: "one", newText: "two" }],
    });
});

// The daemon prepends readiness notes to the prompt it stores; restore strips them from the user's words but keeps them
// as a separate, openable note on the message.
test("restore takes an injected turn preamble off the user's words and keeps it on the message", async () => {
    const notice = [
        "Dependencies are NOT installed for the following projects, so their type-checks, linters and tests cannot work yet",
        "(a dropped project arrives without them on purpose):",
        "- intentic: run `pnpm install` there first.",
    ].join("\n");
    getSessionMessages.mockResolvedValue([{ type: "user", message: { content: `${notice}\n\n---\n\nfix the config` } }]);
    const messages = await readWorkspaceSession(WORKSPACE_ROOT, "s0");
    expect(messages).toEqual([{ role: "user", text: "fix the config", notes: [{ title: "Dependencies aren't installed yet", text: notice }] }]);
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
    const sessions = await listWorkspaceSessions(WORKSPACE_ROOT);
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

test("runtime-handoff search indexes what both sides said before the switch, but not the protocol", async () => {
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

    expect((await searchSessions("/work", "blank chat", false)).map((session) => session.id)).toEqual(["handoff-search"]);
    expect((await searchSessions("/work", "replayStoredSession", false))[0]?.snippet).toEqual({
        text: "I will inspect replayStoredSession.",
        speaker: "agent",
    });
    expect(await searchSessions("/work", "another AI runtime", false)).toEqual([]);
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
