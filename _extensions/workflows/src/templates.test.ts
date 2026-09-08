import { PROVIDERS, type WorkflowStep, workflowFaults, WorkflowSchema } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { WORKFLOW_TEMPLATES } from "./templates";

// Pins every template as a parseable, fault-free workflow, since a template is never exercised before a user picks it.

test("every template parses as a workflow and has no faults", () => {
    for (const template of WORKFLOW_TEMPLATES) {
        const parsed = WorkflowSchema.safeParse(template.workflow);
        expect(parsed.success, `${template.workflow.id}: ${parsed.error?.issues[0]?.message ?? ``}`).toBe(true);
        expect(workflowFaults(template.workflow), template.workflow.id).toEqual([]);
    }
});

test("template ids are unique: the gallery hides one already saved under its id", () => {
    const ids = WORKFLOW_TEMPLATES.map((template) => template.workflow.id);
    expect(new Set(ids).size).toBe(ids.length);
});

// The two racing cards; release-gate is a one-step pitch and doesn't share their fan-out/fan-in shape.
const RACING = WORKFLOW_TEMPLATES.filter(({ workflow }) => workflow.id.startsWith(`two-models`));

test("the template teaches every shape", () => {
    expect(RACING.length, `the gallery lost the racing cards these assertions are about`).toBeGreaterThan(0);
    for (const { workflow } of RACING) {
        const { steps } = workflow;
        // Fans out from a shared predecessor or from the run itself; both count, since both draw as a fork.
        const fansOut =
            steps.filter((step) => step.needs.length === 0).length > 1 ||
            steps.some((step) => steps.filter((other) => other.needs.includes(step.id)).length > 1);
        expect(fansOut, `${workflow.id}: nothing runs beside anything else`).toBe(true);
        expect(
            steps.some((step) => step.needs.length > 1),
            `${workflow.id}: nothing fans back in`,
        ).toBe(true);
        expect(
            new Set(steps.flatMap((step) => (step.agent === undefined ? [] : [step.agent]))).size > 1,
            `${workflow.id}: nothing runs on a second model`,
        ).toBe(true);
    }
});

test("the attempts are unburdened and anonymous in every template", () => {
    for (const { workflow } of RACING) {
        const attempts = workflow.steps.filter((step) => step.id.startsWith(`attempt-`));
        expect(
            attempts.every((step) => step.output.kind === `none` && step.checks.length === 0),
            workflow.id,
        ).toBe(true);
        expect(new Set(attempts.map((step) => step.title)), workflow.id).toEqual(new Set([`Attempt A`, `Attempt B`]));
    }
});

test("the default template is three steps and no completion scaffolding", () => {
    const simple = WORKFLOW_TEMPLATES[0]?.workflow;
    expect(simple?.id).toBe(`two-models-one-task`);
    expect(simple?.steps.map((step) => step.id)).toEqual([`attempt-a`, `attempt-b`, `synthesise`]);
    for (const step of simple?.steps ?? []) {
        expect(step.output.kind, `${step.id} declares an output, which gates its completion`).toBe(`none`);
        expect(step.checks, `${step.id} declares a check against a tree the template cannot see`).toEqual([]);
    }
});

test("the scored template separates blind evaluation from checked synthesis", () => {
    const scored = WORKFLOW_TEMPLATES.find(({ workflow }) => workflow.id === `two-models-scored`)?.workflow;
    const attempts = scored?.steps.filter((step) => step.id.startsWith(`attempt-`)) ?? [];

    const evaluation = scored?.steps.find((step) => step.id === `evaluate`);
    expect(evaluation?.output.kind).toBe(`json`);
    // Asserted as a string first, or an unset agent would also satisfy the not.toBe checks below.
    expect(evaluation?.agent).toEqual(expect.any(String));
    expect(evaluation?.agent).not.toBe(attempts[0]?.agent);
    expect(evaluation?.agent).not.toBe(attempts[1]?.agent);

    const synthesis = scored?.steps.find((step) => step.id === `synthesise`);
    expect(synthesis?.agent).toEqual(expect.any(String));
    expect(synthesis?.output.kind).not.toBe(`none`);
    expect(synthesis?.checks.length).toBeGreaterThan(0);
    expect(synthesis?.needs).toEqual(expect.arrayContaining([`attempt-a`, `attempt-b`, `evaluate`]));
});

test("the steps that start a run add nothing to what the user typed", () => {
    // Scoped to the racing cards; the gate card's root needs a prompt to turn pipeline context into a job.
    for (const { workflow } of RACING) {
        for (const root of workflow.steps.filter((step) => step.needs.length === 0)) {
            expect(root.prompt, `${workflow.id}/${root.id} paraphrases the request instead of taking it`).toBeUndefined();
            expect(root.goal, `${workflow.id}/${root.id} declares a goal the request should be`).toBeUndefined();
        }
    }
});

// True for two steps with identical predecessors and different pinned models: a comparison's two arms.
const sameNeeds = (first: WorkflowStep, second: WorkflowStep): boolean =>
    first.needs.length === second.needs.length && first.needs.every((need) => second.needs.includes(need));

const racingPairs = (steps: readonly WorkflowStep[]): [WorkflowStep, WorkflowStep][] =>
    steps.flatMap((first, at) =>
        steps
            .slice(at + 1)
            .filter((second) => sameNeeds(first, second) && first.agent !== undefined && second.agent !== undefined && first.agent !== second.agent)
            .map((second): [WorkflowStep, WorkflowStep] => [first, second]),
    );

test("attempts that race each other are given the identical task: only the model differs", () => {
    const pairs = WORKFLOW_TEMPLATES.flatMap(({ workflow }) => racingPairs(workflow.steps).map((pair) => ({ id: workflow.id, pair })));
    // Guards against vacuous truth: an empty `pairs` would still pass the loop below.
    expect(pairs.length, `no template runs two models against one brief`).toBeGreaterThan(0);
    for (const { id, pair } of pairs) {
        const [first, second] = pair;
        const task = (step: WorkflowStep) => ({ prompt: step.prompt, goal: step.goal, output: step.output, checks: step.checks });
        expect(task(first), `${id}: "${first.title}" and "${second.title}" were not given the same task`).toEqual(task(second));
    }
});

test("the release-gate template ships wired: one step, gate on its required verdict", () => {
    const gated = WORKFLOW_TEMPLATES.find(({ workflow }) => workflow.id === `release-gate`)?.workflow;
    expect(gated?.steps).toHaveLength(1);
    expect(gated?.gate?.step).toBe(gated?.steps[0]?.id);
    expect(gated?.gate?.pass.length).toBeGreaterThan(0);
    // The gate token is minted per save and kept separately; a template must never carry one.
    expect(Object.keys(gated?.gate ?? {})).not.toContain(`token`);
    const step = gated?.steps[0];
    const field = step?.output.kind === `json` ? step.output.fields.find((entry) => entry.name === gated?.gate?.field) : undefined;
    expect(field?.required, `the gate reads a field the step may omit`).toBe(true);
    expect(field?.type).not.toBe(`string[]`);
});

test("every pinned provider is one the picker offers", () => {
    const known = PROVIDERS.map((provider) => provider.value);
    for (const { workflow } of WORKFLOW_TEMPLATES) {
        for (const pinned of workflow.steps.filter((step) => step.agent !== undefined)) {
            expect(known, `${workflow.id}/${pinned.id}`).toContain(pinned.agent);
        }
    }
});

test("every declared field says what it is for", () => {
    for (const template of WORKFLOW_TEMPLATES) {
        for (const step of template.workflow.steps) {
            if (step.output.kind !== `json`) {
                continue;
            }
            for (const field of step.output.fields) {
                expect(field.description.trim(), `${template.workflow.id}/${step.id}/${field.name}`).not.toBe(``);
            }
        }
    }
});
