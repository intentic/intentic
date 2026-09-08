import { WORKSPACE_ROOT } from "@intentic/constants";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentEvent } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { runAgent } from "./agent.js";
import type { QueryFn } from "./sdk-stream.js";

// Task verbs fold into one live checklist instead of tool cards; a subagent's verbs (marked by parent_tool_use_id) are
// excluded from the parent's list. Stream-level: the fold is only reached through the message loop.

const fakeQuery = (...messages: unknown[]): QueryFn =>
    async function* () {
        for (const message of messages) {
            yield message as SDKMessage;
        }
    };

const collect = async (queryFn: QueryFn): Promise<AgentEvent[]> => {
    const events: AgentEvent[] = [];
    for await (const event of runAgent({ prompt: "plan the work", cwd: WORKSPACE_ROOT, signal: new AbortController().signal }, queryFn)) {
        events.push(event);
    }
    return events;
};

const call = (id: string, name: string, input: unknown, parent?: string): unknown => ({
    type: "assistant",
    session_id: "3f2a9b1c-0000",
    ...(parent === undefined ? {} : { parent_tool_use_id: parent }),
    message: { content: [{ type: "tool_use", id, name, input }] },
});

const result = (id: string, text: string): unknown => ({
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: text }] },
});

const todos = (events: AgentEvent[]): AgentEvent[] => events.filter((event) => event.kind === "todos");

test("the conversation's own Task verbs become the checklist, and no tool card for any of them", async () => {
    const events = await collect(
        fakeQuery(
            call("t1", "TaskCreate", { subject: "Draw the mark" }),
            result("t1", "Task #1 created successfully: Draw the mark"),
            call("t2", "TaskUpdate", { taskId: "1", status: "in_progress" }),
            { type: "result", subtype: "success" },
        ),
    );
    expect(todos(events)).toEqual([
        { kind: "todos", items: [{ content: "Draw the mark", status: "pending" }] },
        { kind: "todos", items: [{ content: "Draw the mark", status: "in_progress" }] },
    ]);
    expect(events.filter((event) => event.kind === "tool_call")).toEqual([]);
});

test("a subagent's Task verbs leave the parent's checklist alone, and raise no card either", async () => {
    const events = await collect(
        fakeQuery(
            call("t1", "TaskCreate", { subject: "Draw the mark" }),
            result("t1", "Task #1 created successfully: Draw the mark"),
            // The child's TaskCreate and its TaskList, which would otherwise replace the parent's list wholesale.
            call("d1", "Agent", { prompt: "review the diff" }),
            call("c1", "TaskCreate", { subject: "Read the diff" }, "d1"),
            result("c1", "Task #1 created successfully: Read the diff"),
            call("c2", "TaskList", {}, "d1"),
            result("c2", "#1 [completed] Read the diff"),
            { type: "result", subtype: "success" },
        ),
    );
    expect(todos(events)).toEqual([{ kind: "todos", items: [{ content: "Draw the mark", status: "pending" }] }]);
    expect(events.filter((event) => event.kind === "tool_call").map((event) => event.name)).toEqual(["Agent"]);
});
