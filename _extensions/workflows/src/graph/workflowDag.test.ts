import type { Workflow, WorkflowStep } from "@intentic/sandbox-contract";
import { addStep } from "../workflowEdit";
import { workflowLayers } from "./workflowDag";

// Steps built through the real editor, then rewired by hand where a test needs a graph the editor refuses to make.
const steps = (n: number): WorkflowStep[] => {
    let workflow: Workflow = { id: `wf`, name: `a workflow`, steps: [], maxParallel: 2 };
    for (let i = 0; i < n; i += 1) {
        workflow = addStep(workflow, undefined).workflow;
    }
    return workflow.steps;
};
// The step at `index`, or a failure naming it: a fixture shorter than the test assumed is the test's own bug.
const at = (list: readonly WorkflowStep[], index: number): WorkflowStep => {
    const step = list[index];
    if (step === undefined) {
        throw new Error(`fixture has no step ${index}`);
    }
    return step;
};
const idsOf = (layers: WorkflowStep[][]): string[][] => layers.map((layer) => layer.map((step) => step.id));

test("columns follow generations: a step sits one past the deepest step it waits on", () => {
    const made = steps(3);
    const [a, b, c] = [at(made, 0), at(made, 1), at(made, 2)];
    const wired = [{ ...c, needs: [a.id, b.id] }, { ...b, needs: [a.id] }, a];
    expect(idsOf(workflowLayers(wired))).toEqual([[a.id], [b.id], [c.id]]);
});

test("a step naming itself is not a cycle, as the graph already draws no such edge", () => {
    // Before the layering was shared with pipelines, this put the step in a trailing column of its own.
    const made = steps(2);
    const [a, b] = [at(made, 0), at(made, 1)];
    expect(idsOf(workflowLayers([{ ...a, needs: [a.id] }, b]))).toEqual([[a.id, b.id]]);
});

test("a cycle the editor would refuse still lays out, in one final column", () => {
    const made = steps(3);
    const [a, b, c] = [at(made, 0), at(made, 1), at(made, 2)];
    expect(idsOf(workflowLayers([a, { ...b, needs: [c.id] }, { ...c, needs: [b.id] }]))).toEqual([[a.id], [b.id, c.id]]);
});
