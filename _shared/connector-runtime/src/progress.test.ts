import { currentStep, elapsedOf, formatElapsed, STEPS_KEPT, stepPhrase, toolWords, trackTurnProgress } from "./progress.js";

const frame = (over: object) => ({ automationId: "a", ...over });

test("the tracker folds a turn's frames into what a status shows", () => {
    let now = 1_000;
    const tracker = trackTurnProgress(() => now);
    tracker.apply(frame({ opened: { conversationId: "c1", link: "https://app/?conversation=c1" } }));
    tracker.apply(frame({ step: { id: "t1", tool: "Read", kind: "read", target: "src/a.ts", status: "running" } }));
    tracker.apply(frame({ step: { id: "t1", tool: "Read", kind: "read", target: "src/a.ts", status: "done" } }));
    tracker.apply(frame({ step: { id: "t2", tool: "Bash", kind: "execute", target: "pnpm test", status: "running" } }));
    tracker.apply(frame({ plan: [{ text: "Fix it", status: "in_progress" }] }));
    now = 5_000;
    const state = tracker.state();
    expect(state.opened?.conversationId).toBe("c1");
    expect(state.steps.map((step) => [step.id, step.status])).toEqual([
        ["t1", "done"],
        ["t2", "running"],
    ]);
    expect(state.stepCount).toBe(2);
    expect(state.plan).toEqual([{ text: "Fix it", status: "in_progress" }]);
    expect(currentStep(state)?.id).toBe("t2");
    expect(state.startedAt).toBe(1_000);
    expect(elapsedOf(state, now)).toBe(4_000);
});

test("a turn that waited before it opened counts its work from the moment it opened", () => {
    let now = 0;
    const tracker = trackTurnProgress(() => now);
    tracker.apply(frame({ queued: "Another task is running" }));
    now = 60_000;
    tracker.apply(frame({ opened: { conversationId: "c1" } }));
    now = 75_000;
    expect(elapsedOf(tracker.state(), now)).toBe(15_000);
});

test("reply text marks the agent as writing until its next step begins", () => {
    const tracker = trackTurnProgress();
    expect(tracker.apply(frame({ delta: "Looking" }))).toBe(true);
    expect(tracker.state().writing).toBe(true);
    // More text changes nothing a status shows.
    expect(tracker.apply(frame({ delta: " at it" }))).toBe(false);
    tracker.apply(frame({ step: { id: "t1", tool: "Grep", kind: "search", target: "redirect", status: "running" } }));
    expect(tracker.state().writing).toBe(false);
});

test("a settled step keeps its status when a later frame for it arrives running, and only the newest steps are kept", () => {
    const tracker = trackTurnProgress();
    tracker.apply(frame({ step: { id: "s", tool: "Agent", kind: "delegate", status: "done" } }));
    tracker.apply(frame({ step: { id: "s", tool: "Agent", kind: "delegate", target: "review the diff", status: "running" } }));
    expect(tracker.state().steps[0]).toEqual({ id: "s", tool: "Agent", kind: "delegate", target: "review the diff", status: "done" });
    for (let index = 0; index < STEPS_KEPT + 5; index += 1) {
        tracker.apply(frame({ step: { id: `t${index}`, tool: "Read", kind: "read", status: "done" } }));
    }
    expect(tracker.state().steps).toHaveLength(STEPS_KEPT);
    expect(tracker.state().stepCount).toBe(STEPS_KEPT + 6);
});

test("held, queued, failed and end are kept for the status to say", () => {
    const tracker = trackTurnProgress();
    tracker.apply(frame({ held: "Waiting for approval" }));
    tracker.apply(frame({ queued: "Two tasks are ahead" }));
    tracker.apply(frame({ failed: "the model refused" }));
    tracker.apply(frame({ end: true }));
    expect(tracker.state()).toMatchObject({ held: "Waiting for approval", queued: "Two tasks are ahead", failed: "the model refused", ended: true });
});

test("steps are worded in the tense their status calls for, objects shortened for a glance", () => {
    expect(stepPhrase({ id: "1", tool: "Read", kind: "read", target: "src/auth/login.ts", status: "running" })).toEqual({ verb: "Reading", object: "src/auth/login.ts" });
    expect(stepPhrase({ id: "2", tool: "Bash", kind: "execute", target: "cd /work/app && pnpm test login\necho done", status: "done" })).toEqual({
        verb: "Ran",
        object: "pnpm test login",
    });
    expect(stepPhrase({ id: "3", tool: "WebFetch", kind: "fetch", target: "https://docs.example.com/guide/start?x=1", status: "done" })).toEqual({
        verb: "Fetched",
        object: "docs.example.com/guide/start",
    });
    const deep = `a/${"segment/".repeat(12)}file.ts`;
    const phrased = stepPhrase({ id: "4", tool: "Edit", kind: "edit", target: deep, status: "failed" });
    expect(phrased.verb).toBe("Edited");
    expect(phrased.object?.startsWith("…/")).toBe(true);
    expect(phrased.object?.endsWith("/file.ts")).toBe(true);
    expect((phrased.object ?? "").length).toBeLessThanOrEqual(72);
});

test("quiet drops what a step acted on, and a tool with no kind of its own is named in words", () => {
    expect(stepPhrase({ id: "1", tool: "Bash", kind: "execute", target: "cat .env", status: "running" }, true)).toEqual({ verb: "Running" });
    expect(stepPhrase({ id: "2", tool: "mcp__github__create_pull_request", kind: "other", status: "done" })).toEqual({ verb: "Used", object: "github: create pull request" });
    expect(toolWords("Skill")).toBe("Skill");
});

test("elapsed time reads in seconds, minutes, then hours", () => {
    expect(formatElapsed(42_400)).toBe("42s");
    expect(formatElapsed(185_000)).toBe("3m 05s");
    expect(formatElapsed(3_720_000)).toBe("1h 02m");
});
