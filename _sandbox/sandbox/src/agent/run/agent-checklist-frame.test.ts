import { WORKSPACE_ROOT } from "@intentic/constants";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentEvent } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { runAgent } from "./agent.js";
import type { QueryFn } from "./sdk-stream.js";

/* THE CHECKLIST'S OWNER. The Task verbs are folded into one live list rather than drawn as tool cards
 * (sdk-stream's onChecklistCall), and that list is read twice: by the chat, which renders it, and by the fleet
 * registry, which asks at the end of the turn what was left on it. Both readings are only worth anything if the
 * list belongs to the conversation whose card is showing it.
 *
 * A SUBAGENT'S VERBS ARRIVE ON THE SAME STREAM, marked with the tool call they are running inside
 * (`parent_tool_use_id`), and they used to fold into the parent's list: a delegation that kept three tasks of
 * its own replaced its parent's checklist, and one that finished them reported the parent's work as done. The
 * child's transcript is assembled from the child's own stream, so nothing is lost by leaving them out here.
 *
 * Stream-level rather than a unit test of the fold, for the reason agent-terminal-frame.test is: what matters
 * is the frames a turn actually emits, and the fold is reached only through the message loop. */

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
    // The list IS their render: a card apiece would bury the transcript under one per status flip.
    expect(events.filter((event) => event.kind === "tool_call")).toEqual([]);
});

test("a subagent's Task verbs leave the parent's checklist alone, and raise no card either", async () => {
    const events = await collect(
        fakeQuery(
            call("t1", "TaskCreate", { subject: "Draw the mark" }),
            result("t1", "Task #1 created successfully: Draw the mark"),
            // The delegation, and the child's own list inside it: its create, and the authoritative TaskList
            // whose result would otherwise replace the parent's list wholesale.
            call("d1", "Agent", { prompt: "review the diff" }),
            call("c1", "TaskCreate", { subject: "Read the diff" }, "d1"),
            result("c1", "Task #1 created successfully: Read the diff"),
            call("c2", "TaskList", {}, "d1"),
            result("c2", "#1 [completed] Read the diff"),
            { type: "result", subtype: "success" },
        ),
    );
    expect(todos(events)).toEqual([{ kind: "todos", items: [{ content: "Draw the mark", status: "pending" }] }]);
    // Suppressed like any checklist verb: no card was emitted for the call, so the result must not arrive as an
    // update to a card that never existed.
    expect(events.filter((event) => event.kind === "tool_call").map((event) => event.name)).toEqual(["Agent"]);
});
