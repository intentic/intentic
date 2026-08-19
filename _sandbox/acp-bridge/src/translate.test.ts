import { expect, test } from "vitest";
import { editorPath, sessionUpdateOf } from "./translate.js";

const CWD = "/home/me/projects/mirror";

test("editorPath joins workspace-relative paths onto the session cwd and strips sandbox-absolute /work", () => {
    expect(editorPath("src/app.ts", CWD)).toBe(`${CWD}/src/app.ts`);
    expect(editorPath("/work/src/app.ts", CWD)).toBe(`${CWD}/src/app.ts`);
    expect(editorPath("/work", CWD)).toBe(CWD);
    expect(editorPath("/tmp/out.txt", CWD)).toBe("/tmp/out.txt");
});

test("tool_call passes the vocabulary through verbatim with editor-joined paths", () => {
    expect(
        sessionUpdateOf(
            {
                kind: "tool_call",
                id: "t1",
                name: "Edit",
                category: "edit",
                status: "in_progress",
                target: "src/app.ts",
                locations: [{ path: "src/app.ts", line: 3 }],
                content: [{ type: "diff", path: "src/app.ts", oldText: "a", newText: "b" }],
            },
            CWD,
        ),
    ).toEqual({
        sessionUpdate: "tool_call",
        toolCallId: "t1",
        title: "Edit: src/app.ts",
        kind: "edit",
        status: "in_progress",
        locations: [{ path: `${CWD}/src/app.ts`, line: 3 }],
        content: [{ type: "diff", path: `${CWD}/src/app.ts`, oldText: "a", newText: "b" }],
    });
});

test("tool_call_update maps statuses and content; text content wraps as a content block", () => {
    expect(sessionUpdateOf({ kind: "tool_call_update", id: "t1", status: "completed", content: [{ type: "text", text: "ok" }] }, CWD)).toEqual({
        sessionUpdate: "tool_call_update",
        toolCallId: "t1",
        status: "completed",
        content: [{ type: "content", content: { type: "text", text: "ok" } }],
    });
});

test("image content becomes a resource_link at the mirror copy of the file", () => {
    expect(
        sessionUpdateOf(
            { kind: "tool_call_update", id: "t1", content: [{ type: "image", path: ".intentic/records/artifacts/browser/shot.png" }] },
            CWD,
        ),
    ).toEqual({
        sessionUpdate: "tool_call_update",
        toolCallId: "t1",
        content: [
            {
                type: "content",
                content: { type: "resource_link", uri: `file://${CWD}/.intentic/records/artifacts/browser/shot.png`, name: "shot.png" },
            },
        ],
    });
});

test("deltas/thinking become message/thought chunks; todos become the ACP plan checklist", () => {
    expect(sessionUpdateOf({ kind: "delta", text: "hi" }, CWD)).toEqual({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "hi" },
    });
    expect(sessionUpdateOf({ kind: "thinking", text: "hmm" }, CWD)).toEqual({
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "hmm" },
    });
    expect(sessionUpdateOf({ kind: "todos", items: [{ content: "step", status: "in_progress" }] }, CWD)).toEqual({
        sessionUpdate: "plan",
        entries: [{ content: "step", priority: "medium", status: "in_progress" }],
    });
});

test("context_usage maps to usage_update; accounting/terminal/checkpoint/commands frames drop", () => {
    expect(sessionUpdateOf({ kind: "context_usage", tokens: 100, contextWindow: 1000 }, CWD)).toEqual({
        sessionUpdate: "usage_update",
        used: 100,
        size: 1000,
    });
    expect(sessionUpdateOf({ kind: "terminal", session: "agent-x" }, CWD)).toBeUndefined();
    expect(sessionUpdateOf({ kind: "usage", costUsd: 1 }, CWD)).toBeUndefined();
    expect(sessionUpdateOf({ kind: "checkpoint", id: "c" }, CWD)).toBeUndefined();
    expect(sessionUpdateOf({ kind: "commands", items: [] }, CWD)).toBeUndefined();
    expect(sessionUpdateOf({ kind: "init", model: "opus" }, CWD)).toBeUndefined();
});
