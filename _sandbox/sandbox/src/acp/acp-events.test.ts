import { WORKSPACE_ROOT } from "@intentic/constants";
import { expect, test } from "vitest";
import { sessionUpdateEvent } from "./acp-events.js";

const CWD = WORKSPACE_ROOT;

test("agent message and thought chunks map to delta/thinking; non-text summarizes by type", () => {
    expect(sessionUpdateEvent({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } }, CWD)).toEqual({
        kind: "delta",
        text: "hi",
    });
    expect(sessionUpdateEvent({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hmm" } }, CWD)).toEqual({
        kind: "thinking",
        text: "hmm",
    });
    expect(sessionUpdateEvent({ sessionUpdate: "agent_message_chunk", content: { type: "image", data: "aa", mimeType: "image/png" } }, CWD)).toEqual({
        kind: "delta",
        text: "[image]",
    });
});

test("tool_call passes ACP's vocabulary through: kind, status, relativized locations, capped diff", () => {
    expect(
        sessionUpdateEvent(
            {
                sessionUpdate: "tool_call",
                toolCallId: "t1",
                title: "Edit app.ts",
                kind: "edit",
                status: "in_progress",
                rawInput: { file_path: `${WORKSPACE_ROOT}/src/app.ts` },
                locations: [{ path: `${WORKSPACE_ROOT}/src/app.ts`, line: 3 }],
                content: [{ type: "diff", path: `${WORKSPACE_ROOT}/src/app.ts`, oldText: "a", newText: "b" }],
            },
            CWD,
        ),
    ).toEqual({
        kind: "tool_call",
        id: "t1",
        name: "Edit app.ts",
        category: "edit",
        status: "in_progress",
        target: `${WORKSPACE_ROOT}/src/app.ts`,
        locations: [{ path: "src/app.ts", line: 3 }],
        content: [{ type: "diff", path: "src/app.ts", oldText: "a", newText: "b" }],
    });
});

test("a tool_call without kind categorizes from its title; without status defaults in_progress", () => {
    expect(sessionUpdateEvent({ sessionUpdate: "tool_call", toolCallId: "t2", title: "Bash" }, CWD)).toEqual({
        kind: "tool_call",
        id: "t2",
        name: "Bash",
        category: "execute",
        status: "in_progress",
    });
});

test("tool_call_update maps status and text content; terminal content entries become panel notes", () => {
    expect(
        sessionUpdateEvent(
            {
                sessionUpdate: "tool_call_update",
                toolCallId: "t1",
                status: "completed",
                content: [
                    { type: "content", content: { type: "text", text: "ok" } },
                    { type: "terminal", terminalId: "term-1" },
                ],
            },
            CWD,
        ),
    ).toEqual({
        kind: "tool_call_update",
        id: "t1",
        status: "completed",
        content: [
            { type: "text", text: "ok" },
            { type: "text", text: "[running in the live terminal panel]" },
        ],
    });
});

test("available_commands_update maps to the commands frame", () => {
    expect(
        sessionUpdateEvent(
            {
                sessionUpdate: "available_commands_update",
                availableCommands: [
                    { name: "web", description: "Search the web", input: { hint: "query" } },
                    { name: "plan", description: "Plan first" },
                ],
            },
            CWD,
        ),
    ).toEqual({
        kind: "commands",
        items: [
            { name: "web", description: "Search the web", hint: "query" },
            { name: "plan", description: "Plan first" },
        ],
    });
});

test("ACP plan is a progress checklist — it maps to todos, never intentic's approval plan frame", () => {
    expect(
        sessionUpdateEvent(
            {
                sessionUpdate: "plan",
                entries: [
                    { content: "step 1", priority: "high", status: "in_progress" },
                    { content: "step 2", priority: "low", status: "pending" },
                ],
            },
            CWD,
        ),
    ).toEqual({
        kind: "todos",
        items: [
            { content: "step 1", status: "in_progress" },
            { content: "step 2", status: "pending" },
        ],
    });
});

test("usage_update maps to context_usage; unmapped updates drop", () => {
    expect(sessionUpdateEvent({ sessionUpdate: "usage_update", used: 1000, size: 200_000 }, CWD)).toEqual({
        kind: "context_usage",
        tokens: 1000,
        contextWindow: 200_000,
    });
    expect(sessionUpdateEvent({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "echo" } }, CWD)).toBeUndefined();
    expect(sessionUpdateEvent({ sessionUpdate: "current_mode_update", currentModeId: "code" }, CWD)).toBeUndefined();
});
