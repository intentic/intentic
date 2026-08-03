import type { Workflow, WorkflowStep } from "@intentic/sandbox-contract";

/* EVERY EDIT A WORKFLOW CAN HAVE, as pure functions over the document.
 *
 * WHY THIS IS NOT IN THE COMPONENT. Graph edits are where the real bugs live — a `needs` left pointing at a
 * deleted step, a cycle drawn by connecting backwards, a `continue` step that ends up with two predecessors —
 * and every one of them is a data fault that the daemon will refuse a save for, hours after the click that
 * caused it. Inside an SFC none of that is reachable by a test; out here all of it is, and the test suite next
 * door asserts the property that actually matters: NO EDIT MAY LEAVE THE GRAPH FAULTY. That rule is worth more
 * than any individual check, because it holds for edits nobody thought to write a case for.
 *
 * (The last bug in this extension was an SFC-only line that no test could reach. Once is a lesson.)
 *
 * EVERY FUNCTION RETURNS A NEW WORKFLOW and never mutates its input. The designer holds a draft and swaps it
 * wholesale, which is what makes Cancel actually cancel.
 *
 * THE INVARIANTS THEY MAINTAIN BETWEEN THEM:
 *  · `needs` only ever names a step that exists.
 *  · the graph stays acyclic — `connect` refuses an edge that would close a loop.
 *  · a `continue` step has exactly one predecessor, and no predecessor is continued twice. Both are repaired
 *    by demoting the offending step to `fresh` rather than by refusing the edit: the user's gesture was about
 *    the DEPENDENCY, and a handoff mode is a detail they can put back.
 */

// What a new step starts as. Everything here is a working default, which is the whole premise of the
// designer's tiering: fill in the two prose fields and the rest already runs.
const DEFAULTS = {
    goal: ``,
    prompt: ``,
    handoff: `fresh`,
    output: { kind: `claim` },
    checks: [],
    context: `fresh`,
    maxIterations: 8,
    stallLimit: 2,
    maxSpendUsd: 5,
} as const satisfies Omit<WorkflowStep, "id" | "title" | "needs">;

/* A slug-shaped, unique id. Minted rather than typed because it is spliced into a conversation id and a git
 * branch name — `wf-<run>-<step>` — so it has a regex to satisfy that a human-typed title does not. The title
 * is what the user names; the id is plumbing they never see.
 */
const mintId = (workflow: Pick<Workflow, "steps">): string => {
    const used = new Set(workflow.steps.map((step) => step.id));
    let n = workflow.steps.length + 1;
    while (used.has(`step-${n}`)) {
        n += 1;
    }
    return `step-${n}`;
};

// Does an edge from → to close a loop? Walked forward from `to`: if we can already reach `from`, the new edge
// would complete a circle. Checked BEFORE the edge is added, so the walk is over the graph as it stands.
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

/* Put a step's handoff back on solid ground after its dependencies changed.
 *
 * `continue` means "carry on the session of the one step above me", so it is only meaningful with exactly one
 * predecessor. Demoting to `fresh` rather than refusing the edit is the right trade: the user was expressing a
 * DEPENDENCY, and silently blocking that to protect a handoff mode would make the canvas feel broken.
 */
const settleHandoff = (step: WorkflowStep): WorkflowStep =>
    step.handoff === `continue` && step.needs.length !== 1 ? { ...step, handoff: `fresh` } : step;

const withSteps = (workflow: Workflow, steps: readonly WorkflowStep[]): Workflow => ({ ...workflow, steps: steps.map(settleHandoff) });

/* Add a step. `after` chains it onto an existing one; absent, it starts the run.
 *
 * Chained by default because a workflow is a sequence far more often than a fan-out, and a new step that
 * arrived unconnected would make the common case two gestures instead of one.
 */
export const addStep = (workflow: Workflow, after?: string): { workflow: Workflow; stepId: string } => {
    const id = mintId(workflow);
    const needs = after !== undefined && workflow.steps.some((step) => step.id === after) ? [after] : [];
    const step: WorkflowStep = { id, title: `Step ${workflow.steps.length + 1}`, needs, ...DEFAULTS };
    return { workflow: withSteps(workflow, [...workflow.steps, step]), stepId: id };
};

/* Draw a dependency. Refused — the workflow comes back unchanged — when it would close a cycle, when either
 * end is missing, or when the edge is already there. Refusing rather than repairing is right for this one:
 * there is no sensible interpretation of "B waits for A" once A already waits for B.
 */
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

/* Remove a step, and take its edges with it. Its dependents lose the reference rather than being left pointing
 * at nothing — producing a dangling `needs` as a side effect of a delete would be the designer breaking its
 * own document, and the fault would surface at save time as a sentence about a step that no longer exists.
 */
export const removeStep = (workflow: Workflow, id: string): Workflow => {
    const withoutNeed = (step: WorkflowStep): WorkflowStep => ({ ...step, needs: step.needs.filter((need) => need !== id) });
    return withSteps(workflow, workflow.steps.filter((step) => step.id !== id).map(withoutNeed));
};

/* Flip how a step meets its predecessor — the choice the designer puts on the EDGE rather than in a form,
 * because it is the one structural decision a reader can see (a solid tie versus a dashed handover) and the
 * one that most changes what the run does.
 *
 * A no-op unless the step has exactly one predecessor, which is the only shape where `continue` means anything.
 */
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
