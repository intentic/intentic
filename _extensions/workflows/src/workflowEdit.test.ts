import { type Workflow, workflowFaults, WorkflowSchema, type WorkflowStep } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { addStep, connectSteps, disconnectSteps, removeStep, toggleHandoff, updateStep } from "./workflowEdit";

/* THE GRAPH EDITS, and one property above all the individual cases: NO EDIT MAY LEAVE THE WORKFLOW FAULTY.
 *
 * `workflowFaults` is the same function the save route refuses with and the designer shows under the canvas,
 * so asserting it stays empty after every mutation is the strongest thing these tests can say — it holds for
 * edits nobody thought to write a case for, which is exactly the class of bug a canvas produces (you can draw
 * a cycle in one gesture, and delete a step three others depend on in another).
 */

const base = (): Workflow => ({
    id: `wf`,
    name: `a workflow`,
    steps: [],
    isolated: true,
    maxParallel: 2,
    maxSpendUsd: 15,
});

// Build a workflow of `n` chained steps through the real API, so the fixtures are themselves an edit trace.
const chain = (n: number): { workflow: Workflow; ids: string[] } => {
    let workflow = base();
    const ids: string[] = [];
    for (let i = 0; i < n; i += 1) {
        const added = addStep(workflow, ids.at(-1));
        workflow = added.workflow;
        ids.push(added.stepId);
    }
    // Prose is the user's job and the faults list does not check it; fill it so the fixture is a legal save.
    for (const id of ids) {
        workflow = updateStep(workflow, id, { goal: `${id} is done`, prompt: `do ${id}` });
    }
    return { workflow, ids };
};

const stepOf = (workflow: Workflow, id: string): WorkflowStep => workflow.steps.find((step) => step.id === id) ?? (undefined as never);

test("a new step is chained onto the one it came from, and starts the run when it came from nothing", () => {
    const first = addStep(base());
    expect(stepOf(first.workflow, first.stepId).needs).toEqual([]);

    const second = addStep(first.workflow, first.stepId);
    expect(stepOf(second.workflow, second.stepId).needs).toEqual([first.stepId]);
});

test("a new step is runnable on its defaults alone — the whole premise of hiding the advanced fields", () => {
    const { workflow } = chain(1);
    // Parses AND has no faults: a user who filled in only the two prose fields can press Run.
    expect(WorkflowSchema.safeParse(workflow).success).toBe(true);
    expect(workflowFaults(workflow)).toEqual([]);
});

test("connecting backwards is refused rather than allowed to close a cycle", () => {
    const { workflow, ids } = chain(3);
    const [a, b, c] = ids as [string, string, string];
    // a → b → c already; c → a would close the loop.
    const attempted = connectSteps(workflow, c, a);
    expect(attempted).toBe(workflow);
    expect(workflowFaults(attempted)).toEqual([]);

    // And the trivial self-edge, which a canvas makes very easy to draw.
    expect(connectSteps(workflow, b, b)).toBe(workflow);
});

test("a fan-in is allowed — two branches meeting is not a cycle", () => {
    let { workflow, ids } = chain(1);
    const root = ids[0] ?? ``;
    const left = addStep(workflow, root);
    workflow = updateStep(left.workflow, left.stepId, { goal: `g`, prompt: `p` });
    const right = addStep(workflow, root);
    workflow = updateStep(right.workflow, right.stepId, { goal: `g`, prompt: `p` });
    const merge = addStep(workflow, left.stepId);
    workflow = updateStep(merge.workflow, merge.stepId, { goal: `g`, prompt: `p` });

    workflow = connectSteps(workflow, right.stepId, merge.stepId);
    expect(stepOf(workflow, merge.stepId).needs).toEqual([left.stepId, right.stepId]);
    expect(workflowFaults(workflow)).toEqual([]);
});

test("removing a step takes its edges with it rather than leaving its dependents dangling", () => {
    const { workflow, ids } = chain(3);
    const [a, b, c] = ids as [string, string, string];

    const without = removeStep(workflow, b);
    expect(without.steps.map((step) => step.id)).toEqual([a, c]);
    // `c` used to need `b`. A dangling need is a fault the save route refuses with — the delete must not create one.
    expect(stepOf(without, c).needs).toEqual([]);
    expect(workflowFaults(without)).toEqual([]);
});

test("a step that loses its only predecessor stops claiming to continue a session", () => {
    const { workflow, ids } = chain(2);
    const [a, b] = ids as [string, string];
    const continued = toggleHandoff(workflow, b);
    expect(stepOf(continued, b).handoff).toBe(`continue`);

    // Disconnecting leaves it a root, where "continue" has nothing to continue — demoted, not left faulty.
    const orphaned = disconnectSteps(continued, a, b);
    expect(stepOf(orphaned, b).handoff).toBe(`fresh`);
    expect(workflowFaults(orphaned)).toEqual([]);

    // Same repair by the other road: deleting the predecessor.
    expect(workflowFaults(removeStep(continued, a))).toEqual([]);
});

test("a step that gains a second predecessor stops claiming to continue a session", () => {
    let { workflow, ids } = chain(2);
    const b = ids[1] ?? ``;
    workflow = toggleHandoff(workflow, b);
    const other = addStep(workflow, undefined);
    workflow = updateStep(other.workflow, other.stepId, { goal: `g`, prompt: `p` });

    // Two upstream sessions cannot both be continued into one, so the handoff gives way — the user's gesture
    // was about the dependency.
    const merged = connectSteps(workflow, other.stepId, b);
    expect(stepOf(merged, b).needs).toHaveLength(2);
    expect(stepOf(merged, b).handoff).toBe(`fresh`);
    expect(workflowFaults(merged)).toEqual([]);
});

test("toggling the handoff does nothing on a step with no single predecessor", () => {
    const { workflow, ids } = chain(1);
    const root = ids[0] ?? ``;
    expect(stepOf(toggleHandoff(workflow, root), root).handoff).toBe(`fresh`);
});

test("every edit leaves the graph runnable — the property the individual cases are examples of", () => {
    const { workflow, ids } = chain(4);
    const [a, b, c, d] = ids as [string, string, string, string];
    const edits: readonly ((current: Workflow) => Workflow)[] = [
        (current) => toggleHandoff(current, b),
        (current) => connectSteps(current, a, c),
        (current) => connectSteps(current, d, a),
        (current) => disconnectSteps(current, b, c),
        (current) => removeStep(current, b),
        (current) => addStep(current, c).workflow,
        (current) => connectSteps(current, c, a),
        (current) => removeStep(current, a),
    ];
    let current = workflow;
    for (const [index, edit] of edits.entries()) {
        current = edit(current);
        expect(workflowFaults(current), `after edit ${index}`).toEqual([]);
    }
});

test("no edit mutates the workflow it was handed — Cancel has to actually cancel", () => {
    const { workflow, ids } = chain(2);
    const before = JSON.stringify(workflow);
    const [a, b] = ids as [string, string];

    addStep(workflow, a);
    connectSteps(workflow, a, b);
    disconnectSteps(workflow, a, b);
    removeStep(workflow, a);
    toggleHandoff(workflow, b);
    updateStep(workflow, a, { title: `renamed` });

    expect(JSON.stringify(workflow)).toBe(before);
});
