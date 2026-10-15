import type { DagEdge, DagNode, IconName } from "@intentic/ui";
import { t } from "@intentic/ui/i18n";
import { providerLabel, type Workflow, type WorkflowRun, type WorkflowStep, type WorkflowStepRun, type WorkflowStepState } from "@intentic/sandbox-contract";

// A workflow run as a graph, for the chat panel's run diagram (ChatRunGraph) and its columns (runColumns). The Workflows
// extension, which is installed from the registry rather than compiled in, draws its designer and run page with its own
// copy of this derivation; the two read the same contract types, so a step looks the same in either place.

export interface WorkflowNode {
    readonly step: WorkflowStep;
    // 1-based position in the workflow, shown so a step can be pointed to by number.
    readonly index: number;
    // How this step is going, when there is a run. Absent for a step drawn without one.
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
const stepTone = () =>
    ({
        pending: { icon: `clock`, text: `text-subtle`, bar: `bg-line`, spin: false, label: t(`chat.workflowDag.waiting`) },
        running: { icon: `spinner`, text: `text-link`, bar: `bg-link`, spin: true, label: t(`chat.workflowDag.running`) },
        done: { icon: `check-circle`, text: `text-success`, bar: `bg-success`, spin: false, label: t(`chat.workflowDag.done`) },
        failed: { icon: `exclamation-triangle`, text: `text-danger`, bar: `bg-danger`, spin: false, label: t(`chat.workflowDag.didNotFinish`) },
        skipped: { icon: `times`, text: `text-subtle`, bar: `bg-line`, spin: false, label: t(`chat.workflowDag.skipped`) },
        stopped: { icon: `stop`, text: `text-subtle`, bar: `bg-line`, spin: false, label: t(`chat.workflowDag.stopped`) },
    }) satisfies Record<WorkflowStepState, StepTone>;

// Neutral, not `pending`: a step with no run has no state to lie about waiting on.
const UNRUN_TONE: StepTone = { icon: `sitemap`, text: `text-subtle`, bar: `bg-line`, spin: false, label: `` };

export const toneFor = (node: WorkflowNode): StepTone => (node.run === undefined ? UNRUN_TONE : stepTone()[node.run.state]);

export interface WorkflowDag {
    readonly nodes: readonly DagNode<WorkflowNode>[];
    readonly edges: readonly DagEdge[];
}

// A dangling `needs` is dropped, not drawn: a design edited after the run started may name a step that is gone.
export const workflowDag = (workflow: Pick<Workflow, "steps">, run?: WorkflowRun): WorkflowDag => {
    const ids = new Set(workflow.steps.map((step) => step.id));
    const runById = new Map((run?.steps ?? []).map((step) => [step.stepId, step]));
    const nodes = workflow.steps.map((step, index): DagNode<WorkflowNode> => {
        const node: DagNode<WorkflowNode> = { id: step.id, data: { step, index: index + 1, run: runById.get(step.id) } };
        // Tooltip is the step's own goal, left absent (not the run's request) so nodes don't all repeat one sentence.
        return step.goal === undefined ? node : { ...node, tooltip: step.goal };
    });
    // Continued handoff draws solid and tinted, a fresh one dashed; the one structural fact node titles don't show.
    // Edges downstream of an unfinished step are dimmed.
    const edgeFrom = (step: WorkflowStep, need: string): DagEdge => {
        const continued = step.handoff === `continue` && step.needs.length === 1;
        const stalledUpstream = runById.get(need)?.state === `skipped` || runById.get(need)?.state === `failed`;
        const edge: DagEdge = { from: need, to: step.id, dashed: !continued, dimmed: stalledUpstream };
        return continued ? { ...edge, accent: `text-link` } : edge;
    };
    const edges = workflow.steps.flatMap((step) =>
        step.needs.filter((need) => ids.has(need) && need !== step.id).map((need) => edgeFrom(step, need)),
    );
    return { nodes, edges };
};

// One line: who runs it (only if pinned), what it produces, what gates it. The provider matters most when two steps
// race on different models.
export const stepSubtitle = (step: WorkflowStep): string => {
    const output =
        step.output.kind === `json`
            ? t(`chat.workflowDag.subtitle.fields`, { count: step.output.fields.length }, step.output.fields.length)
            : step.output.kind === `claim`
              ? t(`chat.workflowDag.subtitle.claim`)
              : t(`chat.workflowDag.subtitle.noOutput`);
    const checks = step.checks.map((check) => (check.kind === `command` ? t(`chat.workflowDag.subtitle.command`) : t(`chat.workflowDag.subtitle.reviewer`)));
    return [...(step.agent === undefined ? [] : [providerLabel(step.agent)]), output, ...checks].join(` · `);
};
