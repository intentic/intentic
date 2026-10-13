import type { AgentEvent } from "@intentic/sandbox-contract";
import { turnProgressReader } from "./listener-progress.js";

const read = (events: readonly AgentEvent[]) => {
    const reader = turnProgressReader();
    return events.map((event) => reader.read(event));
};

test("a call becomes a step, and its update moves that step without losing what it acted on", () => {
    expect(
        read([
            { kind: "tool_call", id: "t1", name: "Bash", category: "execute", status: "in_progress", target: "pnpm test" },
            { kind: "tool_call_update", id: "t1", status: "failed" },
        ]),
    ).toEqual([
        { step: { id: "t1", tool: "Bash", kind: "execute", status: "running", target: "pnpm test" } },
        { step: { id: "t1", tool: "Bash", kind: "execute", status: "failed", target: "pnpm test" } },
    ]);
});

test("a subagent is one delegate step: its call opens it, its description names it, its end settles it", () => {
    expect(
        read([
            { kind: "tool_call", id: "s1", name: "Task", category: "other", status: "in_progress" },
            { kind: "subagent", id: "s1", subagentKind: "subagent", description: "review the diff" },
            { kind: "tool_call", id: "inner", name: "Read", category: "read", status: "in_progress", target: "a.ts", parentToolUseId: "s1" },
            { kind: "subagent_update", id: "s1", status: "running" },
            { kind: "subagent_update", id: "s1", status: "completed" },
        ]),
    ).toEqual([
        { step: { id: "s1", tool: "Task", kind: "delegate", status: "running" } },
        { step: { id: "s1", tool: "Task", kind: "delegate", status: "running", target: "review the diff" } },
        // What the subagent does inside is its own; a still-running update moves nothing.
        undefined,
        undefined,
        { step: { id: "s1", tool: "Task", kind: "delegate", status: "done", target: "review the diff" } },
    ]);
});

test("a spawned child the turn started without a call it saw still shows as a delegate step", () => {
    expect(read([{ kind: "subagent", id: "child-conv", subagentKind: "spawned", description: "port the tests" }])).toEqual([
        { step: { id: "child-conv", tool: "Agent", kind: "delegate", status: "running", target: "port the tests" } },
    ]);
});

test("the checklist arrives as the plan, and its own tool and every other frame say nothing", () => {
    expect(
        read([
            { kind: "tool_call", id: "todo", name: "TodoWrite", category: "think", status: "completed" },
            { kind: "todos", items: [{ content: "Reproduce", status: "completed" }, { content: "Fix", status: "in_progress", activeForm: "Fixing" }] },
            { kind: "delta", text: "hello" },
            { kind: "tool_call_update", id: "unknown", status: "completed" },
        ]),
    ).toEqual([
        undefined,
        {
            plan: [
                { text: "Reproduce", status: "completed" },
                { text: "Fix", status: "in_progress" },
            ],
        },
        undefined,
        undefined,
    ]);
});
