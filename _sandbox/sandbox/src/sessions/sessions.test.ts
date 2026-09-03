import { WORKSPACE_ROOT } from "@intentic/constants";
import { RESUME_NOTES, withResumeNote } from "@intentic/sandbox-contract";
import { expect, test, vi } from "vitest";
import { withRuntimeHistory } from "../agent/runtime-history.js";
import { createRecentSessions, listWorkspaceSessions, readWorkspaceSession, readWorkspaceSessionTail, searchWorkspaceSessions } from "./sessions.js";
import { IN_MEMORY, openSearchIndex } from "./search-index.js";
import { readSessionLines } from "./transcript-search.js";

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
 * The `tag` keeps each test in its own namespace, so two of them cannot end up asserting about the same
 * session id from different fixtures.
 */
const seed = (tag: string, n: number): void => {
    listSessions.mockResolvedValue(Array.from({ length: n }, (_, i) => ({ sessionId: `${tag}${i}`, customTitle: `chat ${i}`, lastModified: n - i })));
    getSessionMessages.mockImplementation(async (id: string) => [{ type: "user", message: { content: `body ${id}` } }]);
};

/* The two steps production runs, in the order it runs them. The BACKFILL reads the SDK store into the index
 * (detached at boot there, inline here); the SEARCH then reads the index and nothing else. Both get fresh
 * instances per call, so no test inherits another's rows and the list's own short TTL cannot answer one test
 * with another's sessions.
 */
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
    // Everything the store had is in the index now. From here a query must not touch the store again.
    getSessionMessages.mockClear();
    const hits = await searchWorkspaceSessions(recent, "chat 1", false, async (...args) => index.search(...args));
    expect(hits.map((s) => s.id)).toEqual(["t1"]);
    // Not "not for t1", which is all the scan could promise: not for ANY row, matched or skipped.
    expect(getSessionMessages).not.toHaveBeenCalled();
    // …and a title match carries no snippet: the row already shows the title it matched on.
    expect(hits[0]?.snippet).toBeUndefined();
});

test("a prompt match is found and reports the line it hit, and whose it was", async () => {
    seed("p", 3);
    const hits = await searchSessions(WORKSPACE_ROOT, "body p2", false);
    expect(hits.map((s) => s.id)).toEqual(["p2"]);
    expect(hits[0]?.snippet).toEqual({ text: "body p2", speaker: "user" });
});

/* TWO QUERIES INSIDE ONE TTL WINDOW, which is what typing in the search box actually is. `recent()` caches its
 * array for 400ms and hands the SAME summary objects to every query in that window, so a search that wrote its
 * snippet onto a row was writing into the cache: type "body p2", backspace, and the next query's rows still
 * carried evidence for a term no longer typed — including rows that now match on their TITLE, which this
 * function promises never carry a snippet at all.
 *
 * Both queries go through ONE `recent`, deliberately: the shared harness above builds a fresh one per call,
 * which is exactly what hid this. */
test("a snippet from one query never rides along on the next", async () => {
    seed("p", 3);
    const { index, recent } = await indexed(WORKSPACE_ROOT);
    const said = async (...args: Parameters<typeof index.search>) => index.search(...args);

    const first = await searchWorkspaceSessions(recent, "body p1", false, said);
    expect(first[0]?.snippet).toEqual({ text: "body p1", speaker: "user" });

    // Same session, now reached by its TITLE: no snippet, not the last query's.
    const byTitle = await searchWorkspaceSessions(recent, "chat 1", false, said);
    expect(byTitle.map((session) => session.id)).toEqual(["p1"]);
    expect(byTitle[0]?.snippet).toBeUndefined();

    // And a different session's body match must not inherit p1's line either.
    const second = await searchWorkspaceSessions(recent, "body p2", false, said);
    expect(second.map((session) => session.id)).toEqual(["p2"]);
    expect(second[0]?.snippet).toEqual({ text: "body p2", speaker: "user" });
});

// The scan used to read transcripts for the ten most recent sessions only, because each read rebuilt the whole
// transcript. It reads the spoken text alone now, and holds it, so recall no longer falls off a cliff at the
// tenth chat, which is precisely where "the one I'm looking for" tends to live.
test("a prompt match past the tenth-newest session is still found", async () => {
    seed("w", 12);
    const hits = await searchSessions(WORKSPACE_ROOT, "body w11", false);
    expect(hits.map((s) => s.id)).toEqual(["w11"]);
});

/* WHERE THE LINE IS: both sides SPEAK, and everything else in a transcript does not. The agent's prose is
 * matchable and reports itself as the agent's; its thinking and its tool output, which between them name most
 * of the workspace's identifiers, and would hand back nearly every chat: are not searchable text at all. */
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

// Both sides can hold the term, and only one line is shown. It is the USER's: a query is typed from memory,
// and what a person remembers is their own phrasing (transcript-search's matchLines).
test("the user's own words are the snippet when both sides said the term", async () => {
    listSessions.mockResolvedValue([{ sessionId: "b0", customTitle: "chat", lastModified: 1 }]);
    getSessionMessages.mockResolvedValue([
        { type: "assistant", message: { content: [{ type: "text", text: "the lane drop is in laneDrop.ts" }] } },
        { type: "user", message: { content: "explain the lane drop" } },
    ]);
    expect((await searchSessions("/work", "lane drop", false))[0]?.snippet).toEqual({ text: "explain the lane drop", speaker: "user" });
});

// The daemon staples a readiness/delegation preamble on the front of a prompt and an attachment note on the
// end (agent.routes.ts). Both are stored verbatim, and both are protocol: matching them would make
// "dependencies" or "attached" hit every agent that ever ran with a setup notice.
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

/* THE FIELD'S Aa SWITCH reaches these rows too: they are listed under the board's own cards, so a query
 * answered case-insensitively here while the cards were matched case-sensitively would be one field showing
 * two rules. Both halves of the rule: the title, and what was said in the transcript. */
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

// A snippet is EVIDENCE, so it has to carry the hit and enough around it to read: windowed, not truncated
// from the front, and with the newlines collapsed so one match can't push the rest of a lane off screen.
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

    // The tool_result-only user message is plumbing, not something the user said: four stored messages, three bubbles.
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "assistant"]);
    expect(messages[0]).toEqual({ role: "user", text: "fix the config" });
    // The prose block closed its bubble, so the calls it introduced sit in the one below: the live arrangement
    // (turnReducer's text_end split), where the sentence stands above the cards it announced.
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
    // The prose block closed its bubble before the create's RESULT arrived (the result is where a create learns
    // its task id), so the checklist renders in the row BENEATH the sentence that announced it: the live fold's
    // own arrangement, where a `todos` frame lands in whatever bubble is open and `text_end` had already retired
    // this one (turn-transcript.ts). Exact shape, so the prose row is asserted to carry no list of its own.
    expect(messages[1]).toEqual({ role: "assistant", text: "Planning work." });
    // The update then moves that same list in place rather than opening a second one, and the checklist verbs
    // emit no cards: the one card in the row is the Read that shared the bubble.
    expect(messages[2]?.todos).toEqual([{ content: "Step 1", status: "in_progress", activeForm: "Doing step 1" }]);
    expect(messages[2]?.tools?.map((tool) => tool.name)).toEqual(["Read"]);
});

/* THE QUESTION A TURN ASKED, rebuilt from the ask tool's own call and result. The store never saw the `question`
 * frame or the reply that released it; it has the call (the questions, as its input) and the result (the picks,
 * as the text the model read), and those redraw the card the user answered, the one part of a turn killed
 * mid-flight a person actually did something in. The card goes down where the live stream raised it, one frame
 * ahead of the call, closing the bubble the prose opened; the call itself lands in the row beneath. */
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

// A dismissal is an answer of its own kind and reads back as one; a call the turn died under (no result at
// all) stays unanswered, which is what happened.
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
    // The second call never got its result: its own card stays in progress, the honest state.
    expect(messages.at(-1)?.tools?.[0]?.status).toBe("in_progress");
});

/* THE SHAPE THE STORE ACTUALLY WRITES, and the regression this is here for: the SDK files a fresh assistant
 * message around every CONTENT block, so a turn that made three calls between two sentences is stored as three
 * lone tool_use messages with a tool_result message between each pair. Folded per stored message that reopened
 * as three separate one-call runs: a ladder of hairlines where the tab had shown a single run of three. */
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

/* The provider's own store keeps the prompt the daemon SENT, note and all, so a conversation the daemon
 * re-ran read back here as the user saying the same thing twice, the second time behind a paragraph of machine
 * prose. It has to read exactly as the daemon's own record does (turn-transcript.ts): the repeat drops out and
 * the interruption stands in its place, because a conversation cannot mean two different things depending on
 * which store happened to answer for it. */
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

/* THE TAIL READ, which exists for one caller: the boot pass writing down a turn the daemon died under. The
 * conversation's record already holds every turn before it, so this must hand back the LAST one and nothing
 * else, or the recovery appends a second copy of the conversation underneath itself. */
test("the tail is the last turn alone, not the session it sits at the end of", async () => {
    getSessionMessages.mockResolvedValue([
        { type: "user", message: { content: "ship the parser" } },
        { type: "assistant", message: { content: [{ type: "text", text: "shipped" }] } },
        { type: "user", message: { content: "now the printer" } },
        { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "pnpm test" } }] } },
    ]);
    const messages = await readWorkspaceSessionTail(WORKSPACE_ROOT, "s0");
    expect(messages.map((message) => message.text)).toEqual(["now the printer", ""]);
    // The turn was cut off mid-call, and the card says so rather than claiming a result it never got.
    expect(messages[1]?.tools?.[0]).toMatchObject({ name: "Bash", status: "in_progress" });
});

// The user message the SDK files around a tool RESULT is plumbing between two calls of ONE turn, not somebody
// speaking. Counting it as a boundary would cut the recovered turn off in the middle of its own work.
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

/* A RE-RUN opens the turn without a user row: the reducer turns a prompt wearing a resume note into the muted
 * line explaining the gap. That line is still a boundary, and finding it is why the split is read off the
 * STORED messages rather than the restored ones, where it is indistinguishable from any other notice. */
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

// One unfinished turn is the whole session, which is the shape every conversation whose FIRST turn was killed
// arrives in, and the one this recovery matters most for: nothing else on disk holds a line of it.
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

// An archived agent's transcript is keyed by its retired worktree path, which the dir-scoped search (workspace
// root + registered worktrees) no longer reaches: the read falls back to the all-projects search rather than
// reporting a transcript that exists on disk as empty.
test("a session outside the dir scope is found by the all-projects fallback", async () => {
    getSessionMessages.mockImplementation(async (_id: string, options?: { dir?: string }) =>
        options?.dir !== undefined ? [] : [{ type: "user", message: { content: "archived words" } }],
    );
    const messages = await readWorkspaceSession(WORKSPACE_ROOT, "s0");
    expect(messages).toEqual([{ role: "user", text: "archived words" }]);
});

// A successful Edit's result is the redundant "file updated" snippet; the card keeps the diff derived from the
// call's own input, exactly as the live stream leaves it.
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

// The daemon prepends readiness/delegation notes to the prompt it files (agent.routes.ts); a redrawn tab must
// show what the user typed, not the protocol around it: the original complaint was the "Dependencies are NOT
// installed" note stapled onto old messages after every refresh. Out of their WORDS, not out of the transcript:
// the note is what the agent was told, so it comes back on the message as a row the reader can open.
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
    // The carried-over reply comes back under the agent, not folded into the user prompt that transported it.
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
