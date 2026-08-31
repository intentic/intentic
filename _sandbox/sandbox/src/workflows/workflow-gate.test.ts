import type { Workflow, WorkflowRun, WorkflowStepRun } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { gateVerdictOf } from "./workflow-gate.js";

/* THE ONE ASYMMETRY THESE TESTS EXIST TO PIN DOWN: exactly one path reaches `fail`, and every other way a run
 * can end reaches `blocked`. A regression that let a failed step, a stopped run or a deadline report `fail`
 * would turn the gate's own outages into red builds, which is the failure mode that gets a release gate
 * switched off, and it would not show up in any test that only checked the happy path.
 */

const design: Workflow = {
    id: "release-gate",
    name: "release gate",
    maxParallel: 1,
    gate: { step: "judge", field: "release", pass: ["pass", "pass-with-warnings"] },
    steps: [
        {
            id: "judge",
            title: "Judge",
            goal: "a release decision exists",
            prompt: "decide",
            needs: [],
            handoff: "fresh",
            output: { kind: "json", fields: [{ name: "release", type: "string", description: "pass | fail", required: true }] },
            checks: [],
            context: "fresh",
        },
    ],
};

const stepRun = (over: Partial<WorkflowStepRun> = {}): WorkflowStepRun => ({
    stepId: "judge",
    state: "done",
    conversationId: "wf-r1-judge",
    iterations: 1,
    ...over,
});

const runWith = (step: WorkflowStepRun, workflow: Workflow = design): WorkflowRun => ({
    runId: "r1",
    workflow,
    repos: [{ repo: "root", base: "1111111111111111111111111111111111111111" }],
    state: "done",
    startedAt: 1,
    resumed: 0,
    steps: [step],
});

const documented = (data: Record<string, unknown>): WorkflowStepRun => stepRun({ document: { done: true, reason: "judged", data } });

test("the declared value being one that ships is the only way to pass", () => {
    const verdict = gateVerdictOf(runWith(documented({ release: "pass" })));
    expect(verdict).toMatchObject({ outcome: "pass", runId: "r1", value: "pass" });
    expect(verdict.reason).toContain("release");
    expect(verdict.reason).toContain("pass");
});

test("any other value fails, and the verdict says what would have shipped", () => {
    const verdict = gateVerdictOf(runWith(documented({ release: "fail" })));
    expect(verdict.outcome).toBe("fail");
    expect(verdict.value).toBe("fail");
    expect(verdict.reason).toContain("fail");
    expect(verdict.reason).toContain("pass-with-warnings");
});

// The hedge the allowlist exists for: a model that answers something adjacent to pass must not ship.
test("a value adjacent to a passing one still fails", () => {
    expect(gateVerdictOf(runWith(documented({ release: "mostly-pass" }))).outcome).toBe("fail");
});

test("a non-string field is compared as the string a form would have authored", () => {
    expect(
        gateVerdictOf(runWith(documented({ release: true }), { ...design, gate: { step: "judge", field: "release", pass: ["true"] } })).outcome,
    ).toBe("pass");
    expect(gateVerdictOf(runWith(documented({ release: 0 }), { ...design, gate: { step: "judge", field: "release", pass: ["1"] } })).outcome).toBe(
        "fail",
    );
});

test("a step that failed is blocked, not failed: the check broke, not the product", () => {
    const detail = "ran out of iterations";
    const verdict = gateVerdictOf(runWith(stepRun({ state: "failed", detail })));
    expect(verdict.outcome).toBe("blocked");
    expect(verdict.reason).toContain("Judge");
    expect(verdict.reason).toContain(detail);
    expect(verdict.value).toBeUndefined();
});

// The deadline's own case: the route cut the run off, so the step is still mid-turn when this reads it.
test("a step still running when the gate stopped waiting is blocked", () => {
    const failed = gateVerdictOf(runWith(stepRun({ state: "failed", detail: "ran out of iterations" })));
    const running = gateVerdictOf(runWith(stepRun({ state: "running" })));
    expect(running.outcome).toBe("blocked");
    expect(running.reason).toContain("Judge");
    expect(running.reason).not.toBe(failed.reason);
});

test("a step skipped behind a broken dependency is blocked", () => {
    const verdict = gateVerdictOf(runWith(stepRun({ state: "skipped" })));
    expect(verdict.outcome).toBe("blocked");
    expect(verdict.reason).toContain("never ran");
});

test("a step that finished without writing the field is blocked", () => {
    const verdict = gateVerdictOf(runWith(documented({ somethingElse: "pass" })));
    expect(verdict.outcome).toBe("blocked");
    expect(verdict.reason).toContain("Judge");
    expect(verdict.reason).toContain("release");
});

test("a step that finished with no document at all is blocked", () => {
    expect(gateVerdictOf(runWith(stepRun())).outcome).toBe("blocked");
});

test("a run whose snapshot has no gate is blocked rather than crashing", () => {
    const { gate: _gate, ...ungated } = design;
    const verdict = gateVerdictOf(runWith(documented({ release: "pass" }), ungated));
    expect(verdict).toMatchObject({ outcome: "blocked", runId: "r1" });
    expect(verdict.reason?.length).toBeGreaterThan(0);
});

/* The rule is read off the RUN's snapshot, so editing the workflow underneath an in-flight run cannot change
 * what that run is judged by. Expressed here as the only thing a unit test can see of it: two runs of the same
 * step, judged by two different snapshotted rules, disagree.
 */
test("the snapshotted rule is what judges, not whatever the workflow says now", () => {
    const step = documented({ release: "fail" });
    expect(gateVerdictOf(runWith(step)).outcome).toBe("fail");
    const lenient = { ...design, gate: { step: "judge", field: "release", pass: ["pass", "fail"] } };
    expect(gateVerdictOf(runWith(step, lenient)).outcome).toBe("pass");
});
