import { expect, test } from "vitest";
import type { Workflow, WorkflowStep } from "./schemas.js";
import { workflowFaults, workflowRunFaults } from "./workflow-faults.js";

/* The GATE rules. The graph rules beside them are exercised by the scheduler's own integration tests, which
 * have a real run to check them against; these have none to check, which is the point — every fault here is one
 * the workflow has to be refused for BEFORE a run, because the failure it prevents costs a full fan-out of
 * sessions and then reports nothing anybody can act on.
 */

const judge = (over: Partial<WorkflowStep> = {}): WorkflowStep => ({
    id: "judge",
    title: "Judge",
    goal: "a release decision exists",
    prompt: "weigh what the steps before you found",
    needs: [],
    handoff: "fresh",
    output: { kind: "json", fields: [{ name: "release", type: "string", description: "pass | fail", required: true }] },
    checks: [],
    context: "fresh",
    ...over,
});

const gated = (over: Partial<Workflow> = {}): Workflow => ({
    id: "release-gate",
    name: "release gate",
    steps: [judge()],
    maxParallel: 1,
    gate: { step: "judge", field: "release", pass: ["pass"] },
    ...over,
});

test("a well-formed gate is no fault at all", () => {
    expect(workflowFaults(gated())).toEqual([]);
});

test("a workflow with no gate is judged on its graph alone", () => {
    const { gate: _gate, ...ungated } = gated();
    expect(workflowFaults(ungated)).toEqual([]);
});

test("a gate naming a step the workflow does not have is refused", () => {
    const faults = workflowFaults(gated({ gate: { step: "nope", field: "release", pass: ["pass"] } }));
    expect(faults).toEqual([`The gate reads step "nope", which is not a step in this workflow.`]);
});

test("a gate on a step that declares no output fields is refused", () => {
    const faults = workflowFaults(gated({ steps: [judge({ output: { kind: "claim" } })] }));
    expect(faults).toEqual([`The gate reads "Judge", but that step declares no output fields for it to read.`]);
});

test("a gate on a field the step does not declare is refused", () => {
    const faults = workflowFaults(gated({ gate: { step: "judge", field: "shipit", pass: ["pass"] } }));
    expect(faults).toEqual([`The gate reads "shipit", which "Judge" does not declare.`]);
});

// A list has no reading as a release decision, and the one it would fall into (join and compare) is a rule
// nobody wrote down.
test("a gate on a list field is refused", () => {
    const steps = [judge({ output: { kind: "json", fields: [{ name: "release", type: "string[]", description: "the verdicts", required: true }] } })];
    const faults = workflowFaults(gated({ steps }));
    expect(faults).toEqual([`The gate reads "release", which is a list — a release decision has to be one value.`]);
});

// The expensive one to discover at run time: it passes every save, then blocks a release on the one commit
// where the model decided the field was not worth writing.
test("a gate on an optional field is refused", () => {
    const steps = [judge({ output: { kind: "json", fields: [{ name: "release", type: "string", description: "pass | fail", required: false }] } })];
    const faults = workflowFaults(gated({ steps }));
    expect(faults).toEqual([`The gate reads "release", which "Judge" declares optional — it has to be required.`]);
});

/* THE RUN-TIME RULE, kept apart from every rule above it because it is not about the graph — and the graph is
 * what gets saved. A design whose steps take their goal and instruction from the request is the ordinary shape
 * and must save cleanly; it is only unrunnable on the particular run that brought no request.
 */

// The shape the whole feature is for: a saved design that says nothing about the task, pointed at today's job.
test("a design whose steps inherit is a perfectly good design", () => {
    const inheriting = gated({ steps: [judge({ goal: undefined, prompt: undefined })] });
    expect(workflowFaults(inheriting)).toEqual([]);
    expect(workflowRunFaults(inheriting, "make the importer handle empty files")).toEqual([]);
});

/* Refused at the door rather than discovered by the first step, because this is the one combination with
 * nothing to tell the model at all — and by the time a step found out, the run has already opened a session per
 * root and started paying for them.
 */
test("running an inheriting design with no request is refused", () => {
    const inheriting = gated({ steps: [judge({ goal: undefined, prompt: undefined })] });
    expect(workflowRunFaults(inheriting, undefined)).toHaveLength(1);
    expect(workflowRunFaults(inheriting, undefined)[0]).toContain(`"Judge"`);
    // Whitespace is not a request. The composer trims before sending, but the gate's webhook body does not.
    expect(workflowRunFaults(inheriting, "   \n ")).toHaveLength(1);
});

// Only half-inheriting is still inheriting: a step with its own instruction but no goal is measured against
// the request, so it needs one just as much.
test("a step that declares only one of the two still needs a request", () => {
    expect(workflowRunFaults(gated({ steps: [judge({ goal: undefined })] }), undefined)).toHaveLength(1);
    expect(workflowRunFaults(gated({ steps: [judge({ prompt: undefined })] }), undefined)).toHaveLength(1);
});

// A design that says everything itself is startable from anywhere, with no composer behind it — which is what
// keeps the gate's webhook and the workflows page working for the designs written that way.
test("a design that declares everything runs with no request at all", () => {
    expect(workflowRunFaults(gated(), undefined)).toEqual([]);
});
