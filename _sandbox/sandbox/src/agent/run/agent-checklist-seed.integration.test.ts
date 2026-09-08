import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WORKSPACE_ROOT } from "@intentic/constants";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentEvent } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { runAgent } from "./agent.js";
import type { QueryFn } from "./sdk-stream.js";
import { taskStoreDir } from "./task-store.js";

/* THE LIST A RESUMED TURN INHERITS. The Task verbs fold into one live list (sdk-stream's onChecklistCall), and
 * an update names its task by id alone, so a turn that resumes a conversation used to start with a fold that
 * knew no ids: every TaskUpdate it made was dropped, no `todos` frame went out, and the fleet card's mark kept
 * the count some earlier turn had written down while the CLI's own list moved on. The store the CLI keeps is
 * read before the CLI starts (task-store.ts) and adopted at the first frame that names the session.
 *
 * Stream-level rather than a unit test of the fold, for the reason agent-checklist-frame.test is: what matters
 * is the frames a turn actually emits, and the seed is reached only through runAgent and the message loop. An
 * integration suite because the seed is read off a real store on disk, which is the whole point of it. */

const SESSION = "6e296ad0-8660-428e-aa79-b014a3c61004";

// A workspace whose Claude state holds the session's list as the previous turn left it.
const workspaceWith = (sessionId: string, tasks: readonly { id: string; subject: string; status: string }[]): string => {
    const root = mkdtempSync(join(tmpdir(), "checklist-seed-"));
    const dir = taskStoreDir(root, sessionId);
    mkdirSync(dir, { recursive: true });
    for (const task of tasks) {
        writeFileSync(join(dir, `${task.id}.json`), JSON.stringify({ ...task, description: task.subject, blocks: [], blockedBy: [] }));
    }
    return root;
};

const fakeQuery = (...messages: unknown[]): QueryFn =>
    async function* () {
        for (const message of messages) {
            yield message as SDKMessage;
        }
    };

const collect = async (workspaceRoot: string, queryFn: QueryFn): Promise<AgentEvent[]> => {
    const events: AgentEvent[] = [];
    const request = { prompt: "carry on", cwd: WORKSPACE_ROOT, workspaceRoot, sessionId: SESSION, signal: new AbortController().signal };
    for await (const event of runAgent(request, queryFn)) {
        events.push(event);
    }
    return events;
};

// An assistant frame from the session the CLI is actually running, which is what the fold reads the id off.
const call = (id: string, name: string, input: unknown, session: string = SESSION): unknown => ({
    type: "assistant",
    session_id: session,
    message: { content: [{ type: "tool_use", id, name, input }] },
});

const todos = (events: AgentEvent[]): AgentEvent[] => events.filter((event) => event.kind === "todos");

test("a resumed turn shows the session's list from its first frame, and its updates to last turn's tasks apply", async () => {
    const root = workspaceWith(SESSION, [
        { id: "1", subject: "Plan", status: "completed" },
        { id: "2", subject: "Build", status: "in_progress" },
        { id: "3", subject: "Verify", status: "pending" },
    ]);
    const events = await collect(
        root,
        fakeQuery(call("t1", "TaskUpdate", { taskId: "2", status: "completed" }), call("t2", "TaskUpdate", { taskId: "3", status: "in_progress" }), {
            type: "result",
            subtype: "success",
        }),
    );
    expect(todos(events)).toEqual([
        {
            kind: "todos",
            items: [
                { content: "Plan", status: "completed" },
                { content: "Build", status: "in_progress" },
                { content: "Verify", status: "pending" },
            ],
        },
        {
            kind: "todos",
            items: [
                { content: "Plan", status: "completed" },
                { content: "Build", status: "completed" },
                { content: "Verify", status: "pending" },
            ],
        },
        {
            kind: "todos",
            items: [
                { content: "Plan", status: "completed" },
                { content: "Build", status: "completed" },
                { content: "Verify", status: "in_progress" },
            ],
        },
    ]);
    // Adopted the moment the session is named, before anything the turn does: the list is there from the start.
    const kinds = events.map((event) => event.kind);
    expect(kinds.indexOf("todos")).toBe(kinds.indexOf("session") + 1);
});

test("a seed for a session the CLI did not resume is dropped, and the fold starts as empty as a first turn's", async () => {
    const root = workspaceWith(SESSION, [{ id: "1", subject: "Plan", status: "pending" }]);
    const events = await collect(
        root,
        fakeQuery(
            // A fresh session: last session's row 1 is not this session's row 1, and must not render as it.
            call("t1", "TaskUpdate", { taskId: "1", status: "completed" }, "0f0f0f0f-fresh-session"),
            { type: "result", subtype: "success" },
        ),
    );
    expect(todos(events)).toEqual([]);
});

test("restoring a session that is immediately refused does not repeat its checklist", async () => {
    const root = workspaceWith(SESSION, [{ id: "1", subject: "Build", status: "pending" }]);
    const events = await collect(
        root,
        fakeQuery(
            { type: "system", subtype: "init", session_id: SESSION },
            { type: "assistant", session_id: SESSION, error: "rate_limit", message: { content: [] } },
        ),
    );

    expect(events).toContainEqual(expect.objectContaining({ kind: "error", code: "rate_limit" }));
    expect(todos(events)).toEqual([]);
});

test("a resumed turn inherits its checklist when prose starts even if it never updates a task", async () => {
    const root = workspaceWith(SESSION, [{ id: "1", subject: "Build", status: "pending" }]);
    const events = await collect(
        root,
        fakeQuery(
            { type: "system", subtype: "init", session_id: SESSION },
            { type: "stream_event", session_id: SESSION, event: { type: "content_block_delta", delta: { type: "text_delta", text: "Working" } } },
            call("t1", "Read", { file_path: "README.md" }),
            { type: "result", subtype: "success" },
        ),
    );

    expect(todos(events)).toEqual([{ kind: "todos", items: [{ content: "Build", status: "pending" }] }]);
    const index = events.findIndex((event) => event.kind === "todos");
    expect(events[index + 1]).toMatchObject({ kind: "delta", text: "Working" });
});
