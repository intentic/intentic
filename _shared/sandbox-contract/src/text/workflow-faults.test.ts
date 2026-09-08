import { expect, test } from "vitest";
import { type Workflow, WorkflowSchema, type WorkflowStep } from "../schemas/workflows.js";
import { workflowFaults, workflowRunFaults } from "./workflow-faults.js";

// Gate rules a workflow must be refused for before any run starts; unlike the graph rules, exercised by the scheduler's
// own integration tests, these have no real run to check against.

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

test("duplicate output field names are one fault at both authoring and schema boundaries", () => {
    const duplicate = gated({
        steps: [
            judge({
                output: {
                    kind: "json",
                    fields: [
                        { name: "release", type: "string", description: "pass | fail", required: true },
                        { name: "release", type: "boolean", description: "whether to release", required: true },
                    ],
                },
            }),
        ],
    });

    expect(workflowFaults(duplicate)).toContain(`"Judge" declares the output field "release" more than once; field names must be unique.`);
    expect(WorkflowSchema.safeParse(duplicate).success).toBe(false);
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

test("a gate on a list field is refused", () => {
    const steps = [judge({ output: { kind: "json", fields: [{ name: "release", type: "string[]", description: "the verdicts", required: true }] } })];
    const faults = workflowFaults(gated({ steps }));
    expect(faults).toEqual([`The gate reads "release", which is a list: a release decision has to be one value.`]);
});

test("a gate on an optional field is refused", () => {
    const steps = [judge({ output: { kind: "json", fields: [{ name: "release", type: "string", description: "pass | fail", required: false }] } })];
    const faults = workflowFaults(gated({ steps }));
    expect(faults).toEqual([`The gate reads "release", which "Judge" declares optional, it has to be required.`]);
});

// Run-time rule, apart from the graph rules above: a design whose steps inherit goal/prompt from the request saves
// cleanly and is only unrunnable on a run with no request.

test("a design whose steps inherit is a perfectly good design", () => {
    const inheriting = gated({ steps: [judge({ goal: undefined, prompt: undefined })] });
    expect(workflowFaults(inheriting)).toEqual([]);
    expect(workflowRunFaults(inheriting, "make the importer handle empty files")).toEqual([]);
});

test("running an inheriting design with no request is refused", () => {
    const inheriting = gated({ steps: [judge({ goal: undefined, prompt: undefined })] });
    expect(workflowRunFaults(inheriting, undefined)).toHaveLength(1);
    expect(workflowRunFaults(inheriting, undefined)[0]).toContain(`"Judge"`);
    // Whitespace-only requests come from the gate's webhook body, which isn't trimmed like the composer.
    expect(workflowRunFaults(inheriting, "   \n ")).toHaveLength(1);
});

test("a step that declares only one of the two still needs a request", () => {
    expect(workflowRunFaults(gated({ steps: [judge({ goal: undefined })] }), undefined)).toHaveLength(1);
    expect(workflowRunFaults(gated({ steps: [judge({ prompt: undefined })] }), undefined)).toHaveLength(1);
});

test("a design that declares everything runs with no request at all", () => {
    expect(workflowRunFaults(gated(), undefined)).toEqual([]);
});
