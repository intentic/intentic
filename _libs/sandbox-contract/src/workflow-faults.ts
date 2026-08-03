/* WHY A WORKFLOW GRAPH IS NOT RUNNABLE — the rules that `WorkflowSchema` cannot state, because each of them is
 * about the graph rather than about one field.
 *
 * A rule per function, so the reason a graph is refused reads as one sentence in one place. They are
 * concatenated in the order the user meets them: what is wrong with the ids, then what is wrong with each step,
 * then what is wrong BETWEEN steps.
 */

import { loopCanConverge, type Workflow, type WorkflowStep } from "./schemas.js";

// One id, one node: the scheduler keys needs, runs and the drawn graph by it, so a repeat makes the same node
// mean two things.
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

// A step that continues a session needs exactly one session to continue. Zero (a root) has nothing to carry on
// from; two would have to pick, and picking silently is how a workflow quietly drops half its context.
const continuesOneSession = (step: WorkflowStep): boolean => step.handoff === "continue" && step.needs.length === 1;

// What is wrong with this step on its own, given the ids the workflow actually has.
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
                ? `"${step.title}" continues a session but starts the run — there is nothing to continue.`
                : `"${step.title}" continues a session but waits for ${step.needs.length} steps; it can only continue one.`,
        );
    }
    // A step with nothing to produce and nothing to check cannot end except by running out of iterations — the
    // same bar a loop has to clear, and the same predicate.
    if (!loopCanConverge(step)) {
        faults.push(`"${step.title}" has no output and no check, so nothing can tell it it is finished.`);
    }
    return faults;
};

/* Two steps continuing the SAME session is the one graph that is legal on paper and broken in practice: both
 * would run on one conversation, in parallel, against one worktree and one turn mutex — so they would serialize
 * on a lock neither knows about and the second would inherit a session the first had moved on. A predecessor
 * can be continued once; anything else that needs its result takes it as a handover. */
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

// Cycles, by walking every path from every root. A workflow with a cycle has steps that can never start, and the
// scheduler would simply wait forever on them rather than saying so.
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

/* A GATE THAT CANNOT BE ANSWERED. Every rule here is about the gate against the GRAPH — which is why none of
 * them can live in the schema — and all of them fail the same expensive way if unchecked: the run spends its
 * whole fan-out of sessions and then answers `blocked`, on every commit, for a reason nobody sees until they
 * go reading the daemon's log.
 *
 * The `string[]` refusal is the least obvious and the most worth having. A release decision is one value
 * compared against a list of values that ship; a field holding several has no such reading, and the one the
 * gate would fall into (join them and compare the string) is a rule nobody wrote down and nobody could guess.
 */
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
        return [`The gate reads "${gate.field}", which is a list — a release decision has to be one value.`];
    }
    // A field the step may legally omit is a gate that answers `blocked` whenever it does, which is a release
    // stuck on a technicality rather than on the product.
    return field.required ? [] : [`The gate reads "${gate.field}", which "${step.title}" declares optional — it has to be required.`];
};

/* Why the graph is not runnable, as a list of sentences. Empty ⇒ it is. Shared by the save route (which
 * refuses) and the designer (which shows them under the canvas as you type), because a rule enforced only
 * daemon-side is a rule the user meets as a failed save with no idea which node is wrong.
 */
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

/* WHAT ONLY A RUN CAN BE WRONG ABOUT — kept apart from the rules above because it is not about the graph, and
 * the graph is what gets SAVED. A design whose steps take their goal and instruction from the request is a
 * perfectly good design; it is only unrunnable on the particular run that forgot to bring one.
 *
 * Which is why this cannot be a save-time rule and must not become one: refusing to save such a workflow would
 * outlaw the entire point of a workflow being a SHAPE. The check belongs at the two doors that start runs — the
 * run route and the gate's webhook — and it has to be there rather than left to fail later, because "later"
 * means every session in the fan-out has already been paid for before anyone finds out the model was handed an
 * empty instruction.
 */
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
