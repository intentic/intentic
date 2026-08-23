import type { InteractionUpdate } from "@cursor/sdk";
import { expect, test } from "vitest";
import { createCursorEventMapper } from "./cursor-events.js";

const CWD = "/work";

/* THE TYPES ARE REAL, AND THIS IS WHAT SAYS SO. `@cursor/sdk` asks for zod ^3 while this workspace overrides
 * zod to 4 for everything else; under that override every `z.infer` in the SDK's published .d.ts collapses to
 * `unknown`, and the whole adapter would type-check as `any` while looking fully typed. pnpm-workspace.yaml
 * scopes the override back off @cursor/sdk to repair it.
 *
 * A TYPE-LEVEL assertion, deliberately: nothing runs here, and that is the point. If the repair is ever undone
 * `InteractionUpdate` becomes `unknown`, `Extract<…>` yields `never`, and the object below stops being
 * assignable — a compile error in this file, naming the reason, instead of a silent loss of every type in the
 * Cursor adapter. */
const textDelta: Extract<InteractionUpdate, { type: "text-delta" }> = { type: "text-delta", text: "hello" };

// Cast at the edge rather than throughout: these are hand-built fixtures of a 16-member discriminated union
// whose tool-call arm alone has 16 shapes, and spelling every optional field would test the fixture, not the
// mapper.
const update = (value: unknown): InteractionUpdate => value as InteractionUpdate;

test("assistant prose streams as deltas, and a plan phase captures it instead", () => {
    expect(createCursorEventMapper(CWD).map(textDelta)).toEqual([{ kind: "delta", text: "hello" }]);

    const planning = createCursorEventMapper(CWD, true);
    expect(planning.map(textDelta)).toEqual([]);
    expect(planning.map(update({ type: "text-delta", text: " world" }))).toEqual([]);
    // The captured text IS the plan the card will show, which is why a planning phase must not stream it.
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
    // Named and categorised as every other runtime's shell, so an identical command sorts, filters and icons
    // the same whichever provider ran it. The command itself is the card's target, which is how the shared
    // taxonomy already renders a Bash call and is why it is not spelled out per adapter.
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

/* An edit's change arrives ALREADY RENDERED as a unified diff, so it goes out as text rather than as the
 * structured `diff` content every other adapter produces: that shape wants the before and after of the file,
 * and reconstructing those from a patch would risk showing a diff that does not match what landed on disk. */
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
    // "no such file" and "permission denied" send a reader to different places, which is the whole reason the
    // message is passed through.
    expect(frames).toEqual([{ kind: "tool_call_update", id: "c4", status: "failed", content: [{ type: "text", text: "no such file" }] }]);
});

test("live shell output accumulates, because content REPLACES rather than appends", () => {
    const mapper = createCursorEventMapper(CWD);
    mapper.map(update({ type: "tool-call-started", callId: "c5", modelCallId: "m5", toolCall: { type: "shell", args: { command: "ls" } } }));
    expect(mapper.map(update({ type: "shell-output-delta", event: { output: "one\n" } }))).toEqual([
        { kind: "tool_call_update", id: "c5", content: [{ type: "text", text: "one\n" }] },
    ]);
    // The second frame carries BOTH lines: a client applying snapshot semantics to a delta would show only the
    // most recent one.
    expect(mapper.map(update({ type: "shell-output-delta", event: { output: "two\n" } }))).toEqual([
        { kind: "tool_call_update", id: "c5", content: [{ type: "text", text: "one\ntwo\n" }] },
    ]);
});

/* The shell-output update's payload is an UNTYPED passthrough in the SDK, so its field names are not part of
 * the published contract. An unrecognised shape is dropped rather than thrown on: the card shows its output a
 * moment later when the call completes, which is a far better failure than a turn that dies on a rename. */
test("an unrecognised shell-output shape is dropped, not thrown on", () => {
    const mapper = createCursorEventMapper(CWD);
    mapper.map(update({ type: "tool-call-started", callId: "c6", modelCallId: "m6", toolCall: { type: "shell", args: { command: "ls" } } }));
    expect(mapper.map(update({ type: "shell-output-delta", event: { somethingElse: 3 } }))).toEqual([]);
});

test("output with no shell call in flight belongs to nothing and is dropped", () => {
    expect(createCursorEventMapper(CWD).map(update({ type: "shell-output-delta", event: { output: "orphan" } }))).toEqual([]);
});

/* The checklist is a frame of its own and never a card: a todo list rendered as a tool call is both duplicated
 * (the panel already draws it) and useless in a transcript. `cancelled` reads as completed because the
 * alternative leaves a checklist that can never finish. */
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
    // Nothing reported yet ⇒ no frame at all. A row of zeros would be a claim; silence is the truth.
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

// Argument streaming and the loop's own bookkeeping have no UI meaning: passing them through would be noise a
// client has to learn to ignore.
test("updates with no UI meaning are dropped", () => {
    const mapper = createCursorEventMapper(CWD);
    for (const type of ["partial-tool-call", "tool-call-delta", "token-delta", "step-started", "step-completed", "summary", "thinking-completed"]) {
        expect(mapper.map(update({ type, callId: "x", tokens: 1 }))).toEqual([]);
    }
});
