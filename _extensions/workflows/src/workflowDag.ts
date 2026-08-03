import type { DagEdge, DagNode, IconName } from "@intentic/extension-ui";
import {
    providerLabel,
    type Workflow,
    type WorkflowRun,
    type WorkflowStep,
    type WorkflowStepRun,
    type WorkflowStepState,
} from "@intentic/sandbox-contract";

/* THE GRAPH, as both the designer and the run view draw it — one derivation, two consumers, so what you author
 * and what you watch can never be different pictures of the same workflow. That is the whole reason this is a
 * module and not two components' worth of computed properties: a designer whose preview lays out differently
 * from the run is worse than no preview at all, because you would trust it.
 *
 * The node payload carries everything a card renders. `run` is absent in the designer — that absence IS the
 * mode, and it is why one component can draw both.
 */

export interface WorkflowNode {
    readonly step: WorkflowStep;
    // The step's position in the workflow, 1-based. Shown on the node because a graph with no numbers is hard
    // to talk about ("the third one" needs a third one).
    readonly index: number;
    // How this step is going, when there is a run. Absent in the designer.
    readonly run: WorkflowStepRun | undefined;
}

export interface StepTone {
    readonly icon: IconName;
    readonly text: string;
    readonly bar: string;
    readonly spin: boolean;
    readonly label: string;
}

/* What each state looks like, and the two decisions in here that matter:
 *
 * `skipped` IS NOT AN ERROR COLOUR. A skipped step did nothing wrong — something upstream did — and painting a
 * cascade of them red makes one failure look like nine. Muted, so the eye lands on the one red node.
 *
 * `stopped` IS NOT AN ERROR COLOUR EITHER. The user did that on purpose, and telling them off for it is how a
 * status vocabulary loses its meaning: if everything that is not `done` is red, red stops saying anything.
 */
export const STEP_TONE: Record<WorkflowStepState, StepTone> = {
    pending: { icon: `clock`, text: `text-subtle`, bar: `bg-line`, spin: false, label: `Waiting` },
    running: { icon: `spinner`, text: `text-link`, bar: `bg-link`, spin: true, label: `Running` },
    done: { icon: `check-circle`, text: `text-success`, bar: `bg-success`, spin: false, label: `Done` },
    failed: { icon: `exclamation-triangle`, text: `text-danger`, bar: `bg-danger`, spin: false, label: `Did not finish` },
    skipped: { icon: `times`, text: `text-subtle`, bar: `bg-line`, spin: false, label: `Skipped` },
    stopped: { icon: `stop`, text: `text-subtle`, bar: `bg-line`, spin: false, label: `Stopped` },
};

// The designer's own tone: a step that has never run has no state to show, so it reads as neutral rather than
// as `pending` — "waiting" would be a lie about a workflow that is not going.
export const DESIGN_TONE: StepTone = { icon: `sitemap`, text: `text-subtle`, bar: `bg-line`, spin: false, label: `` };

export const toneFor = (node: WorkflowNode): StepTone => (node.run === undefined ? DESIGN_TONE : STEP_TONE[node.run.state]);

export interface WorkflowDag {
    readonly nodes: readonly DagNode<WorkflowNode>[];
    readonly edges: readonly DagEdge[];
}

/* Build the graph. `run` is optional: with one, nodes carry live state and the edges into finished work are
 * tinted; without one, this is the designer's preview.
 *
 * A DANGLING `needs` IS DROPPED RATHER THAN DRAWN. The save route refuses those, but the designer renders on
 * every keystroke — including the keystroke halfway through renaming a step id, when half the edges point at a
 * name that does not exist yet. Dropping them keeps the preview stable while you type; the fault list below
 * the canvas is what tells you about it.
 */
export const workflowDag = (workflow: Pick<Workflow, "steps">, run?: WorkflowRun): WorkflowDag => {
    const ids = new Set(workflow.steps.map((step) => step.id));
    const runById = new Map((run?.steps ?? []).map((step) => [step.stepId, step]));
    const nodes = workflow.steps.map((step, index): DagNode<WorkflowNode> => ({
        id: step.id,
        data: {
            step,
            index: index + 1,
            run: runById.get(step.id),
        },
        /* The node's hover text is the step's own goal, and ABSENT when it has none rather than filled in with
         * something else. A step that inherits is measured against the run's request, which the run bar above
         * the graph is already showing — repeating it on every node would put the same sentence under all of
         * them and say nothing about which node is which. `undefined` leaves the node with no tooltip, which is
         * the honest answer to "what is this step's own bar" when it has not set one. */
        ...(step.goal === undefined ? {} : { tooltip: step.goal }),
    }));
    /* A continued handoff draws solid and tinted, a fresh one dashed: the solid line says "this is the same
     * agent carrying on", the dash says "this is a handover to someone new". It is the one structural fact
     * about a workflow you cannot read off the node titles.
     *
     * Everything downstream of a step that never finished is dimmed, so a live graph reads as "here is what is
     * still actually happening" rather than as a full map with some colour on it. */
    const edgeFrom = (step: WorkflowStep, need: string): DagEdge => {
        const continued = step.handoff === `continue` && step.needs.length === 1;
        const stalledUpstream = runById.get(need)?.state === `skipped` || runById.get(need)?.state === `failed`;
        return {
            from: need,
            to: step.id,
            ...(continued ? { accent: `text-link` } : { dashed: true }),
            ...(stalledUpstream ? { dimmed: true } : {}),
        };
    };
    const edges = workflow.steps.flatMap((step) =>
        step.needs.filter((need) => ids.has(need) && need !== step.id).map((need) => edgeFrom(step, need)),
    );
    return { nodes, edges };
};

/* One line under a node's title: who runs it, what it produces, and what gates it — in the fewest words that
 * still say which.
 *
 * THE PROVIDER LEADS when a step pins one, and it is the only part of this line that is about the AGENT rather
 * than the work. It has to be on the card because there is one design where the model is the whole point — the
 * same brief built by two of them, side by side — and a graph that draws those two steps identically would be
 * hiding the only thing that differs between them. Absent for the ordinary step, which pins nothing.
 */
export const stepSubtitle = (step: WorkflowStep): string => {
    const output =
        step.output.kind === `json`
            ? `${step.output.fields.length} field${step.output.fields.length === 1 ? `` : `s`}`
            : step.output.kind === `claim`
              ? `a claim`
              : `no output`;
    const checks = step.checks.map((check) => (check.kind === `command` ? `a command` : `a reviewer`));
    return [...(step.agent === undefined ? [] : [providerLabel(step.agent)]), output, ...checks].join(` · `);
};
