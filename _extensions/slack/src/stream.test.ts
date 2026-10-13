import type { CardView, TurnProgress } from "@intentic/connector-runtime";
import { streamChunks, streamShown, streamTitle } from "./stream.js";

// What a view adds to a Slack stream: a title when it changed, and each step that is new or moved on.

const progress = (over: Partial<TurnProgress> = {}): TurnProgress => ({
    startedAt: 0,
    openedAt: 0,
    opened: { conversationId: "conv-1" },
    steps: [],
    stepCount: 0,
    writing: false,
    ended: false,
    ...over,
});
const view = (over: Partial<TurnProgress> = {}, rest: Partial<CardView> = {}): CardView => ({ progress: progress(over), now: 72_000, detail: "steps", ...rest });

test("the title says the checklist item in progress and how far along it is, else the narration, and how it ended", () => {
    const plan = [
        { text: "Reproduce", status: "completed" as const },
        { text: "Fix the guard", status: "in_progress" as const },
        { text: "Test", status: "pending" as const },
    ];
    expect(streamTitle(view({ plan }))).toBe("Fix the guard (2/3) · 1m 12s");
    expect(streamTitle(view({}, { headline: "Looking at the auth module." }))).toBe("Looking at the auth module. · 1m 12s");
    expect(streamTitle(view())).toBe("Working on it · 1m 12s");
    expect(streamTitle(view({ ended: true, stepCount: 4 }))).toBe("Done · 1m 12s · 4 steps");
    expect(streamTitle(view({ ended: true }, { stoppedBy: "Mark" }))).toBe("Stopped by Mark · 1m 12s");
});

test("each edit sends only what changed: a new step, a step settling, a new title", () => {
    const shown = streamShown();
    const reading = { id: "s1", tool: "Read", kind: "read" as const, target: "src/a.ts" };
    expect(streamChunks(view({ steps: [{ ...reading, status: "running" }] }), shown)).toEqual([
        { type: "plan_update", title: "Working on it · 1m 12s" },
        { type: "task_update", id: "s1", title: "Reading src/a.ts", status: "in_progress" },
    ]);
    // Nothing changed: nothing to send.
    expect(streamChunks(view({ steps: [{ ...reading, status: "running" }] }), shown)).toEqual([]);
    expect(streamChunks(view({ steps: [{ ...reading, status: "failed" }] }), shown)).toEqual([{ type: "task_update", id: "s1", title: "Read src/a.ts", status: "error" }]);
});

test("quiet leaves out what each step touched", () => {
    const steps = [{ id: "s1", tool: "Bash", kind: "execute" as const, target: "pnpm test", status: "running" as const }];
    expect(streamChunks(view({ steps }, { detail: "quiet" }), streamShown())).toContainEqual({ type: "task_update", id: "s1", title: "Running", status: "in_progress" });
});
