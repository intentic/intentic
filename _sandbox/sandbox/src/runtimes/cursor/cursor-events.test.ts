import type { InteractionUpdate } from "@cursor/sdk";
import { expect, test } from "vitest";
import { createCursorEventMapper } from "./cursor-events.js";

const CWD = "/work";

// Type-only guard: zod is overridden to 4 elsewhere but @cursor/sdk needs zod ^3, so pnpm-workspace.yaml exempts it; if
// that exemption breaks, this assignment fails to compile instead of every SDK type silently becoming unknown.
const textDelta: Extract<InteractionUpdate, { type: "text-delta" }> = { type: "text-delta", text: "hello" };

// Casts at the edge: spelling every field of this 16-shape union would test the fixture, not the mapper.
const update = (value: unknown): InteractionUpdate => value as InteractionUpdate;

test("assistant prose streams as deltas, and a plan phase captures it instead", () => {
    expect(createCursorEventMapper(CWD).map(textDelta)).toEqual([{ kind: "delta", text: "hello" }]);

    const planning = createCursorEventMapper(CWD, true);
    expect(planning.map(textDelta)).toEqual([]);
    expect(planning.map(update({ type: "text-delta", text: " world" }))).toEqual([]);
    expect(planning.capture().planText).toBe("hello world");
});

test("a shell call opens a Bash card, not a card headed `shell`", () => {
    const mapper = createCursorEventMapper(CWD);
    const frames = mapper.map(
        update({
            type: "tool-call-started",
            callId: "c1",
            modelCallId: "m1",
            toolCall: { type: "shell", args: { command: "pnpm test" } },
        }),
    );
    expect(frames).toEqual([{ kind: "tool_call", id: "c1", name: "Bash", category: "execute", status: "in_progress", target: "pnpm test" }]);
});

test("a write's whole new file is drawn as a diff at CALL time, before any result exists", () => {
    const [frame] = createCursorEventMapper(CWD).map(
        update({
            type: "tool-call-started",
            callId: "c2",
            modelCallId: "m2",
            toolCall: { type: "write", args: { path: "/work/src/a.ts", fileText: "export const a = 1;\n" } },
        }),
    );
    expect(frame).toMatchObject({
        kind: "tool_call",
        name: "Write",
        category: "edit",
        target: "src/a.ts",
        content: [{ type: "diff", path: "src/a.ts", newText: "export const a = 1;\n" }],
    });
});

test("an edit's result carries the vendor's own diff, as text", () => {
    const mapper = createCursorEventMapper(CWD);
    mapper.map(update({ type: "tool-call-started", callId: "c3", modelCallId: "m3", toolCall: { type: "edit", args: { path: "/work/a.ts" } } }));
    expect(
        mapper.map(
            update({
                type: "tool-call-completed",
                callId: "c3",
                modelCallId: "m3",
                toolCall: { type: "edit", args: { path: "/work/a.ts" }, result: { status: "success", diffString: "@@ -1 +1 @@\n-a\n+b\n" } },
            }),
        ),
    ).toEqual([{ kind: "tool_call_update", id: "c3", status: "completed", content: [{ type: "text", text: "@@ -1 +1 @@\n-a\n+b\n" }] }]);
});

test("a failed call reports the vendor's own sentence, not a generic one", () => {
    const frames = createCursorEventMapper(CWD).map(
        update({
            type: "tool-call-completed",
            callId: "c4",
            modelCallId: "m4",
            toolCall: { type: "read", args: { path: "/work/gone.ts" }, result: { status: "error", message: "no such file" } },
        }),
    );
    expect(frames).toEqual([{ kind: "tool_call_update", id: "c4", status: "failed", content: [{ type: "text", text: "no such file" }] }]);
});

test("live shell output accumulates, because content REPLACES rather than appends", () => {
    const mapper = createCursorEventMapper(CWD);
    mapper.map(update({ type: "tool-call-started", callId: "c5", modelCallId: "m5", toolCall: { type: "shell", args: { command: "ls" } } }));
    expect(mapper.map(update({ type: "shell-output-delta", event: { output: "one\n" } }))).toEqual([
        { kind: "tool_call_update", id: "c5", content: [{ type: "text", text: "one\n" }] },
    ]);
    expect(mapper.map(update({ type: "shell-output-delta", event: { output: "two\n" } }))).toEqual([
        { kind: "tool_call_update", id: "c5", content: [{ type: "text", text: "one\ntwo\n" }] },
    ]);
});

// Shell-output payloads are an untyped SDK passthrough; an unrecognised shape is dropped, not thrown, since the card
// catches up when the call completes.
test("an unrecognised shell-output shape is dropped, not thrown on", () => {
    const mapper = createCursorEventMapper(CWD);
    mapper.map(update({ type: "tool-call-started", callId: "c6", modelCallId: "m6", toolCall: { type: "shell", args: { command: "ls" } } }));
    expect(mapper.map(update({ type: "shell-output-delta", event: { somethingElse: 3 } }))).toEqual([]);
});

test("output with no shell call in flight belongs to nothing and is dropped", () => {
    expect(createCursorEventMapper(CWD).map(update({ type: "shell-output-delta", event: { output: "orphan" } }))).toEqual([]);
});

// cancelled maps to completed: the alternative leaves a checklist that can never finish.
test("todos become a todos frame, and Cursor's fourth state is mapped rather than dropped", () => {
    expect(
        createCursorEventMapper(CWD).map(
            update({
                type: "tool-call-started",
                callId: "c7",
                modelCallId: "m7",
                toolCall: {
                    type: "updateTodos",
                    args: {
                        todos: [
                            { content: "one", status: "inProgress" },
                            { content: "two", status: "cancelled" },
                            { content: "three", status: "pending" },
                        ],
                    },
                },
            }),
        ),
    ).toEqual([
        {
            kind: "todos",
            items: [
                { content: "one", status: "in_progress" },
                { content: "two", status: "completed" },
                { content: "three", status: "pending" },
            ],
        },
    ]);
});

test("usage is summed across a turn's phases and reported once", () => {
    const mapper = createCursorEventMapper(CWD);
    expect(mapper.usage()).toBeUndefined();
    const usage = { inputTokens: 10, outputTokens: 4, cacheReadTokens: 2, cacheWriteTokens: 1, reasoningTokens: 3 };
    mapper.map(update({ type: "turn-ended", usage }));
    mapper.map(update({ type: "turn-ended", usage }));
    expect(mapper.usage()).toEqual({ kind: "usage", inputTokens: 20, outputTokens: 8, cacheReadTokens: 4, cacheCreationTokens: 2 });
});

test("a turn that ended without reporting usage sends no usage frame", () => {
    const mapper = createCursorEventMapper(CWD);
    mapper.map(update({ type: "turn-ended" }));
    expect(mapper.usage()).toBeUndefined();
});

test("updates with no UI meaning are dropped", () => {
    const mapper = createCursorEventMapper(CWD);
    for (const type of ["partial-tool-call", "tool-call-delta", "token-delta", "step-started", "step-completed", "summary", "thinking-completed"]) {
        expect(mapper.map(update({ type, callId: "x", tokens: 1 }))).toEqual([]);
    }
});
