import type { AttachFrame, TranscriptTool } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { createTranslator, editorPath } from "./translate.js";

const CWD = "/home/me/projects/mirror";

const patch = (change: Extract<AttachFrame, { kind: "patch" }>["patch"]): AttachFrame => ({ kind: "patch", seq: 1, patch: change });

const EDIT: TranscriptTool = {
    id: "t1",
    name: "Edit",
    category: "edit",
    status: "in_progress",
    target: "src/app.ts",
    locations: [{ path: "src/app.ts", line: 3 }],
    content: [{ type: "diff", path: "src/app.ts", oldText: "a", newText: "b" }],
};

test("editorPath joins workspace-relative paths onto the session cwd and strips sandbox-absolute /work", () => {
    expect(editorPath("src/app.ts", CWD)).toBe(`${CWD}/src/app.ts`);
    expect(editorPath("/work/src/app.ts", CWD)).toBe(`${CWD}/src/app.ts`);
    expect(editorPath("/work", CWD)).toBe(CWD);
    expect(editorPath("/tmp/out.txt", CWD)).toBe("/tmp/out.txt");
});

test("a tool card's first sighting is a tool_call with editor-joined paths; the next is a tool_call_update", () => {
    const translate = createTranslator(CWD);
    expect(translate(patch({ op: "tool", index: 1, tool: EDIT }))).toEqual([
        {
            sessionUpdate: "tool_call",
            toolCallId: "t1",
            title: "Edit: src/app.ts",
            kind: "edit",
            status: "in_progress",
            locations: [{ path: `${CWD}/src/app.ts`, line: 3 }],
            content: [{ type: "diff", path: `${CWD}/src/app.ts`, oldText: "a", newText: "b" }],
        },
    ]);
    expect(translate(patch({ op: "tool", index: 1, tool: { ...EDIT, status: "completed", content: [{ type: "text", text: "ok" }] } }))).toEqual([
        {
            sessionUpdate: "tool_call_update",
            toolCallId: "t1",
            status: "completed",
            locations: [{ path: `${CWD}/src/app.ts`, line: 3 }],
            content: [{ type: "content", content: { type: "text", text: "ok" } }],
        },
    ]);
});

test("image content becomes a resource_link at the mirror copy of the file", () => {
    const translate = createTranslator(CWD);
    const shot: TranscriptTool = {
        id: "t2",
        name: "Screenshot",
        category: "other",
        status: "completed",
        content: [{ type: "image", path: ".intentic/records/artifacts/browser/shot.png" }],
    };
    expect(translate(patch({ op: "tool", index: 1, tool: shot }))).toEqual([
        {
            sessionUpdate: "tool_call",
            toolCallId: "t2",
            title: "Screenshot",
            kind: "other",
            status: "completed",
            content: [
                {
                    type: "content",
                    content: { type: "resource_link", uri: `file://${CWD}/.intentic/records/artifacts/browser/shot.png`, name: "shot.png" },
                },
            ],
        },
    ]);
});

test("a helper's nested calls are announced with their parent, once each", () => {
    const translate = createTranslator(CWD);
    const parent: TranscriptTool = {
        id: "p",
        name: "Agent",
        category: "other",
        status: "in_progress",
        children: [{ id: "c", name: "Read", category: "read", status: "completed" }],
    };
    expect(
        translate(patch({ op: "tool", index: 1, tool: parent })).map((update) => [
            update.sessionUpdate,
            "toolCallId" in update ? update.toolCallId : undefined,
        ]),
    ).toEqual([
        ["tool_call", "p"],
        ["tool_call", "c"],
    ]);
    expect(translate(patch({ op: "tool", index: 1, tool: parent })).map((update) => update.sessionUpdate)).toEqual([
        "tool_call_update",
        "tool_call_update",
    ]);
});

test("prose and thinking become message/thought chunks; a checklist on a replaced row becomes the ACP plan", () => {
    const translate = createTranslator(CWD);
    expect(translate(patch({ op: "text", index: 1, text: "hi" }))).toEqual([
        { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } },
    ]);
    expect(translate(patch({ op: "thinking", index: 1, text: "hmm" }))).toEqual([
        { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hmm" } },
    ]);
    expect(
        translate(patch({ op: "replace", index: 1, row: { role: "assistant", text: "", todos: [{ content: "step", status: "in_progress" }] } })),
    ).toEqual([{ sessionUpdate: "plan", entries: [{ content: "step", priority: "medium", status: "in_progress" }] }]);
    expect(translate(patch({ op: "replace", index: 1, row: { role: "assistant", text: "" } }))).toEqual([]);
});

test("a notice row is one message chunk; an appended bubble is nothing until its prose arrives", () => {
    const translate = createTranslator(CWD);
    expect(translate(patch({ op: "append", row: { role: "notice", text: "Changes landed in your workspace." } }))).toEqual([
        { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Changes landed in your workspace." } },
    ]);
    expect(translate(patch({ op: "append", row: { role: "assistant", text: "" } }))).toEqual([]);
    expect(translate(patch({ op: "drop", index: 1 }))).toEqual([]);
});

test("context_usage maps to usage_update; the head, the end, and accounting or terminal facts drop", () => {
    const translate = createTranslator(CWD);
    expect(translate({ kind: "fact", seq: 1, fact: { kind: "context_usage", tokens: 100, contextWindow: 1000 } })).toEqual([
        { sessionUpdate: "usage_update", used: 100, size: 1000 },
    ]);
    expect(translate({ kind: "fact", seq: 2, fact: { kind: "terminal", session: "agent-x" } })).toEqual([]);
    expect(translate({ kind: "fact", seq: 3, fact: { kind: "usage", costUsd: 1 } })).toEqual([]);
    expect(translate({ kind: "fact", seq: 4, fact: { kind: "init", model: "opus" } })).toEqual([]);
    expect(translate({ kind: "attached", run: "r", startedAt: 0, seq: 0, rows: [] })).toEqual([]);
    expect(translate({ kind: "end" })).toEqual([]);
});
