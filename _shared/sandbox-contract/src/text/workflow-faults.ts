// Rules a workflow graph fails that WorkflowSchema can't express, one function per rule, since each is about the graph
// rather than one field. Concatenated in the order a user meets them: ids, then each step, then between steps.

import { duplicateOutputFieldNames } from "../policy/output-fields.js";
import type { Workflow, WorkflowStep } from "../schemas/workflows.js";

// One id, one node: the scheduler keys needs, runs and the drawn graph by it, so a repeated id makes one node mean two
// things.
const duplicateIdFaults = (steps: readonly WorkflowStep[]): string[] => {
    const seen = new Set<string>();
    const faults: string[] = [];
    for (const step of steps) {
        if (seen.has(step.id)) {
            faults.push(`Two steps share the id "${step.id}".`);
        }
        seen.add(step.id);
    }
    return faults;
};

// A step continuing a session needs exactly one to continue: zero is a root, two would have to silently pick which.
const continuesOneSession = (step: WorkflowStep): boolean => step.handoff === "continue" && step.needs.length === 1;

const stepFaults = (step: WorkflowStep, ids: ReadonlySet<string>): string[] => {
    const faults = step.needs
        .filter((need) => !ids.has(need))
        .map((need) => `"${step.title}" waits for "${need}", which is not a step in this workflow.`);
    if (step.needs.includes(step.id)) {
        faults.push(`"${step.title}" waits for itself.`);
    }
    if (step.handoff === "continue" && !continuesOneSession(step)) {
        faults.push(
            step.needs.length === 0
                ? `"${step.title}" continues a session but starts the run: there is nothing to continue.`
                : `"${step.title}" continues a session but waits for ${step.needs.length} steps; it can only continue one.`,
        );
    }
    if (step.output.kind === "json") {
        faults.push(
            ...duplicateOutputFieldNames(step.output.fields).map(
                (name) => `"${step.title}" declares the output field "${name}" more than once; field names must be unique.`,
            ),
        );
    }
    // A step declaring no output is not a fault, unlike a loop; it just ends when the turn does.
    return faults;
};

// Two steps continuing the same session would run in parallel against one worktree and turn mutex; only one may
// continue a given predecessor, others must take a handover.
const sharedContinuationFaults = (steps: readonly WorkflowStep[]): string[] => {
    const continued = new Map<string, string[]>();
    for (const step of steps.filter(continuesOneSession)) {
        const parent = step.needs[0] ?? "";
        const titles = continued.get(parent) ?? [];
        titles.push(step.title);
        continued.set(parent, titles);
    }
    return [...continued]
        .filter(([, titles]) => titles.length > 1)
        .map(([parent, titles]) => `${titles.map((title) => `"${title}"`).join(" and ")} all continue "${parent}"'s session; only one step can.`);
};

// Finds cycles by walking every path from every root; the scheduler would otherwise wait forever on steps that can
// never start.
const cycleFaults = (steps: readonly WorkflowStep[]): string[] => {
    const needsById = new Map(steps.map((step) => [step.id, step.needs]));
    const state = new Map<string, "open" | "closed">();
    const faults: string[] = [];
    const walk = (id: string, trail: readonly string[]): void => {
        if (state.get(id) === "closed") {
            return;
        }
        if (state.get(id) === "open") {
            faults.push(`These steps wait for each other in a circle: ${[...trail.slice(trail.indexOf(id)), id].join(" → ")}.`);
            return;
        }
        state.set(id, "open");
        for (const need of needsById.get(id) ?? []) {
            if (needsById.has(need)) {
                walk(need, [...trail, id]);
            }
        }
        state.set(id, "closed");
    };
    for (const step of steps) {
        walk(step.id, []);
    }
    return faults;
};

// Gate-against-graph rules that can't live in the schema; unchecked, a run pays for its whole fan-out before failing
// every commit. A field holding a list has no reading as a release decision, so it is refused outright.
const gateFaults = (workflow: Pick<Workflow, "steps" | "gate">): string[] => {
    const { gate } = workflow;
    if (gate === undefined) {
        return [];
    }
    const step = workflow.steps.find((entry) => entry.id === gate.step);
    if (step === undefined) {
        return [`The gate reads step "${gate.step}", which is not a step in this workflow.`];
    }
    if (step.output.kind !== "json") {
        return [`The gate reads "${step.title}", but that step declares no output fields for it to read.`];
    }
    const field = step.output.fields.find((entry) => entry.name === gate.field);
    if (field === undefined) {
        return [`The gate reads "${gate.field}", which "${step.title}" does not declare.`];
    }
    if (field.type === "string[]") {
        return [`The gate reads "${gate.field}", which is a list: a release decision has to be one value.`];
    }
    // Schema requires pass.length >= 1 only at save; a live-edited draft can still have an empty allowlist.
    if (gate.pass.length === 0) {
        return [`The gate names no passing values, so no run could ever ship.`];
    }
    // An optional field's gate would block on the one run where the model chose not to write it.
    return field.required ? [] : [`The gate reads "${gate.field}", which "${step.title}" declares optional, it has to be required.`];
};

// All faults that make a graph unrunnable, empty when there are none. Shared by the save route and the designer, so the
// same rule surfaces the same way in both.
export const workflowFaults = (workflow: Pick<Workflow, "steps" | "gate">): string[] => {
    const ids = new Set(workflow.steps.map((step) => step.id));
    return [
        ...duplicateIdFaults(workflow.steps),
        ...workflow.steps.flatMap((step) => stepFaults(step, ids)),
        ...sharedContinuationFaults(workflow.steps),
        ...cycleFaults(workflow.steps),
        ...gateFaults(workflow),
    ];
};

// Faults only a run reveals, not a save: a design that takes goal/instruction from the request is fine to save, only
// unrunnable without one. Checked at both doors that start a run, before sessions are opened.
export const workflowRunFaults = (workflow: Pick<Workflow, "steps">, request: string | undefined): string[] => {
    if (request !== undefined && request.trim() !== "") {
        return [];
    }
    const inheriting = workflow.steps.filter((step) => step.goal === undefined || step.prompt === undefined);
    if (inheriting.length === 0) {
        return [];
    }
    return [
        `${inheriting.map((step) => `"${step.title}"`).join(", ")} take their goal or their instruction from what the run was asked to do, ` +
            `and this run was started without a request. Say what you want built, or give those steps a goal and a prompt of their own.`,
    ];
};
