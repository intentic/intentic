import type { Workflow, WorkflowStep } from "@intentic/sandbox-contract";

// Pure functions over the workflow document; each returns a new workflow rather than mutating its input. Invariants
// held across all: `needs` only names a step that exists, the graph stays acyclic, and a `continue` step has exactly
// one predecessor, repaired by demoting to `fresh` rather than refusing the edit.

// goal and prompt are absent, not empty: empty is a declared instruction the schema refuses.
const DEFAULTS = {
    handoff: `fresh`,
    // none is not a completion gate; a step is finished when its turn is finished, not on a verdict file.
    output: { kind: `none` },
    checks: [],
    context: `fresh`,
} as const satisfies Omit<WorkflowStep, "id" | "title" | "needs">;

// Minted rather than typed: it is spliced into a conversation id and a git branch name (`wf-<run>-<step>`), which a
// human-typed title need not satisfy.
const mintId = (workflow: Pick<Workflow, "steps">): string => {
    const used = new Set(workflow.steps.map((step) => step.id));
    let n = workflow.steps.length + 1;
    while (used.has(`step-${n}`)) {
        n += 1;
    }
    return `step-${n}`;
};

// Does an edge from → to close a loop? Checked before the edge is added, by walking forward from `to` for `from`.
const reaches = (steps: readonly WorkflowStep[], from: string, to: string): boolean => {
    const byId = new Map(steps.map((step) => [step.id, step]));
    const seen = new Set<string>();
    const walk = (id: string): boolean => {
        if (id === to) {
            return true;
        }
        if (seen.has(id)) {
            return false;
        }
        seen.add(id);
        return (byId.get(id)?.needs ?? []).some(walk);
    };
    return walk(from);
};

// Puts a step's handoff back on solid ground after its dependencies changed; `continue` is only meaningful with exactly
// one predecessor.
const settleHandoff = (step: WorkflowStep): WorkflowStep =>
    step.handoff === `continue` && step.needs.length !== 1 ? { ...step, handoff: `fresh` } : step;

const withSteps = (workflow: Workflow, steps: readonly WorkflowStep[]): Workflow => ({ ...workflow, steps: steps.map(settleHandoff) });

// Adds a step. `after` chains it onto an existing one; absent, it starts the run.
export const addStep = (workflow: Workflow, after?: string): { workflow: Workflow; stepId: string } => {
    const id = mintId(workflow);
    const needs = after !== undefined && workflow.steps.some((step) => step.id === after) ? [after] : [];
    const step: WorkflowStep = { id, title: `Step ${workflow.steps.length + 1}`, needs, ...DEFAULTS };
    return { workflow: withSteps(workflow, [...workflow.steps, step]), stepId: id };
};

// Draws a dependency. Refused (workflow returned unchanged) if it would close a cycle, either end is missing, or the
// edge already exists.
export const connectSteps = (workflow: Workflow, from: string, to: string): Workflow => {
    const target = workflow.steps.find((step) => step.id === to);
    const sourceExists = workflow.steps.some((step) => step.id === from);
    if (target === undefined || !sourceExists || from === to || target.needs.includes(from) || reaches(workflow.steps, from, to)) {
        return workflow;
    }
    return withSteps(
        workflow,
        workflow.steps.map((step) => (step.id === to ? { ...step, needs: [...step.needs, from] } : step)),
    );
};

export const disconnectSteps = (workflow: Workflow, from: string, to: string): Workflow =>
    withSteps(
        workflow,
        workflow.steps.map((step) => (step.id === to ? { ...step, needs: step.needs.filter((need) => need !== from) } : step)),
    );

// Removes a step and its edges, so dependents lose the reference rather than being left with a dangling `needs`.
export const removeStep = (workflow: Workflow, id: string): Workflow => {
    const withoutNeed = (step: WorkflowStep): WorkflowStep => ({ ...step, needs: step.needs.filter((need) => need !== id) });
    return withSteps(workflow, workflow.steps.filter((step) => step.id !== id).map(withoutNeed));
};

// Flips how a step meets its predecessor. A no-op unless the step has exactly one predecessor, the only shape where
// `continue` means anything.
export const toggleHandoff = (workflow: Workflow, id: string): Workflow =>
    withSteps(
        workflow,
        workflow.steps.map((step) =>
            step.id === id && step.needs.length === 1 ? { ...step, handoff: step.handoff === `continue` ? `fresh` : `continue` } : step,
        ),
    );

export const updateStep = (workflow: Workflow, id: string, over: Partial<WorkflowStep>): Workflow =>
    withSteps(
        workflow,
        workflow.steps.map((step) => (step.id === id ? { ...step, ...over } : step)),
    );
