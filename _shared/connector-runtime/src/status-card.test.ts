import type { TurnProgress } from "./progress.js";
import { PLAN_SHOWN, progressDetailOf, STEPS_SHOWN, statusCardOf, stopButtonId, stopTarget } from "./status-card.js";

// What a status card says about a turn, before any platform draws it.

const notOpened = (over: Partial<TurnProgress> = {}): TurnProgress => ({ startedAt: 0, steps: [], stepCount: 0, writing: false, ended: false, ...over });
const opened = (over: Partial<TurnProgress> = {}): TurnProgress =>
    notOpened({ openedAt: 0, opened: { conversationId: "conv-1", link: "https://app.intentic.dev/?conversation=conv-1" }, ...over });

test("a working card lists the last steps, worded, offers Stop and the link, and says what it does between steps", () => {
    const steps = Array.from({ length: STEPS_SHOWN + 2 }, (_, index) => ({
        id: `${index}`,
        tool: "Read",
        kind: "read" as const,
        target: `src/f${index}.ts`,
        status: "done" as const,
    }));
    const card = statusCardOf({ progress: opened({ steps, stepCount: steps.length, writing: true }), now: 72_000, detail: "steps", headline: "Found it." });
    expect(card).toMatchObject({ state: "working", live: true, elapsed: "1m 12s", earlier: 2, headline: "Found it.", idle: "writing", stop: "conv-1" });
    expect(card.steps).toHaveLength(STEPS_SHOWN);
    expect(card.steps[0]).toEqual({ status: "done", verb: "Read", object: "src/f2.ts" });
    expect(card.link).toBe("https://app.intentic.dev/?conversation=conv-1");
});

test("quiet leaves out what each step touched", () => {
    const steps = [{ id: "1", tool: "Bash", kind: "execute" as const, target: "pnpm test", status: "running" as const }];
    const card = statusCardOf({ progress: opened({ steps, stepCount: 1 }), now: 0, detail: "quiet" });
    expect(card.steps).toEqual([{ status: "running", verb: "Running" }]);
    expect(card.idle).toBeUndefined();
});

test("a finished card keeps the checklist and the link, and offers no Stop", () => {
    const plan = Array.from({ length: PLAN_SHOWN + 1 }, (_, index) => ({ text: `item ${index}`, status: "completed" as const }));
    const card = statusCardOf({ progress: opened({ plan, ended: true, stepCount: 3 }), now: 5_000, detail: "steps" });
    expect(card).toMatchObject({ state: "done", live: false, stepCount: 3, planMore: 1, steps: [] });
    expect(card.plan).toHaveLength(PLAN_SHOWN);
    expect(card.stop).toBeUndefined();
    expect(card.link).toBe("https://app.intentic.dev/?conversation=conv-1");
});

test("a turn that never opened says why it waits, or that it never ran", () => {
    expect(statusCardOf({ progress: notOpened({ held: "Needs approval." }), now: 0, detail: "steps" })).toMatchObject({ state: "held", note: "Needs approval." });
    expect(statusCardOf({ progress: notOpened({ queued: "Another request is running." }), now: 0, detail: "steps" })).toMatchObject({
        state: "queued",
        note: "Another request is running.",
    });
    expect(statusCardOf({ progress: notOpened({ failed: "refused", ended: true }), now: 0, detail: "steps" }).state).toBe("not-started");
    expect(statusCardOf({ progress: notOpened({ ended: true }), now: 0, detail: "steps" }).state).toBe("not-run");
});

test("Stop pressed: stopping while the turn winds down, stopped once it ended, with who pressed it", () => {
    expect(statusCardOf({ progress: opened(), now: 0, detail: "steps", stoppedBy: "Mark" })).toMatchObject({ state: "stopping", stoppedBy: "Mark", live: false });
    expect(statusCardOf({ progress: opened({ ended: true }), now: 0, detail: "steps", stoppedBy: "Mark" }).state).toBe("stopped");
});

test("a Stop button's id carries its conversation back, and anything else is not a Stop", () => {
    expect(stopTarget(stopButtonId("conv-9"))).toBe("conv-9");
    expect(stopTarget("intentic:stop:")).toBeUndefined();
    expect(stopTarget("something-else")).toBeUndefined();
    expect(progressDetailOf("quiet")).toBe("quiet");
    expect(progressDetailOf(undefined)).toBe("steps");
    expect(progressDetailOf("garbage")).toBe("steps");
});
