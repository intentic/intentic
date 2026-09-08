import type { DagEdge, DagNode, IconName } from "@intentic/extension-ui";
import {
    providerLabel,
    type Workflow,
    type WorkflowRun,
    type WorkflowStep,
    type WorkflowStepRun,
    type WorkflowStepState,
} from "@intentic/sandbox-contract";

// Shared graph derivation for both the designer and the run view, so what's authored and what's watched can never be
// different pictures of the same workflow. `run` is absent on a node in the designer; that absence is what makes it the
// designer rather than a separate mode flag.

export interface WorkflowNode {
    readonly step: WorkflowStep;
    // 1-based position in the workflow, shown so a step can be pointed to by number.
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

// `skipped` and `stopped` are muted, not red, since neither is a failure.
export const STEP_TONE: Record<WorkflowStepState, StepTone> = {
    pending: { icon: `clock`, text: `text-subtle`, bar: `bg-line`, spin: false, label: `Waiting` },
    running: { icon: `spinner`, text: `text-link`, bar: `bg-link`, spin: true, label: `Running` },
    done: { icon: `check-circle`, text: `text-success`, bar: `bg-success`, spin: false, label: `Done` },
    failed: { icon: `exclamation-triangle`, text: `text-danger`, bar: `bg-danger`, spin: false, label: `Did not finish` },
    skipped: { icon: `times`, text: `text-subtle`, bar: `bg-line`, spin: false, label: `Skipped` },
    stopped: { icon: `stop`, text: `text-subtle`, bar: `bg-line`, spin: false, label: `Stopped` },
};

// Neutral, not `pending`: an unrun step in the designer has no state to lie about waiting on.
const DESIGN_TONE: StepTone = { icon: `sitemap`, text: `text-subtle`, bar: `bg-line`, spin: false, label: `` };

export const toneFor = (node: WorkflowNode): StepTone => (node.run === undefined ? DESIGN_TONE : STEP_TONE[node.run.state]);

export interface WorkflowDag {
    readonly nodes: readonly DagNode<WorkflowNode>[];
    readonly edges: readonly DagEdge[];
}

// `run` is optional: without one this is the designer's preview. A dangling `needs` is dropped, not drawn, since the
// designer renders on every keystroke, including mid-rename.
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
        // Tooltip is the step's own goal, left absent (not the run's request) so nodes don't all repeat one sentence.
        ...(step.goal === undefined ? {} : { tooltip: step.goal }),
    }));
    // Continued handoff draws solid and tinted, a fresh one dashed; the one structural fact node titles don't show.
    // Edges downstream of an unfinished step are dimmed.
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

// Columns by generation (steps waiting on nothing, then what they unblock), for the frame height and parallelism label
// before dagre lays out. A cycle can't hang it: whatever is left goes in one final column.
export const workflowLayers = (steps: readonly WorkflowStep[]): WorkflowStep[][] => {
    const ids = new Set(steps.map((step) => step.id));
    const placed = new Set<string>();
    const layers: WorkflowStep[][] = [];
    let waiting = [...steps];
    while (waiting.length > 0) {
        // A `needs` naming nothing is dropped, not waited on, matching the graph above.
        const ready = waiting.filter((step) => step.needs.every((need) => !ids.has(need) || placed.has(need)));
        const layer = ready.length > 0 ? ready : waiting;
        layer.forEach((step) => placed.add(step.id));
        layers.push(layer);
        waiting = waiting.filter((step) => !placed.has(step.id));
    }
    return layers;
};

// One line: who runs it (only if pinned), what it produces, what gates it. The provider matters most when two steps
// race on different models.
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
