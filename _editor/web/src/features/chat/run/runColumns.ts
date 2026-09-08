import { layoutDag } from "@intentic/ui";
import type { DagNode } from "@intentic/ui";
import { workflowDag } from "@intentic/ext-workflows";
import type { WorkflowRun, WorkflowStepRun } from "@intentic/sandbox-contract";
import { type RunColumn, type RunSession, sessionOf } from "./chatRun";

// The diagram's columns: split from chatRun so run state stays importable everywhere (the summons channel reaches it
// from every window) without dragging in the UI/dag layout library. Only the diagram imports this.

// Shared with the diagram component: the graph the user clicks and the columns computed here must agree on node size,
// or the seam between columns would land where nobody can see it.
export const RUN_NODE_WIDTH = 216;
export const RUN_NODE_HEIGHT = 62;

// `skipped` and `pending` steps have no session, however real their derived conversation id looks: `skipped` never
// started (something upstream didn't finish), so opening it offered a chat that was never created.
const ran = (state: WorkflowStepRun["state"]): boolean => state !== `pending` && state !== `skipped`;

// Grouped by the laid-out x position, not dependency depth: dagre may draw a step beside the work it feeds rather than
// the work it waited for, and a second opinion on depth would disagree with the picture the user clicked.
export const runColumns = (run: WorkflowRun): Map<string, RunColumn> => {
    const { nodes, edges } = workflowDag(run.workflow, run);
    const { nodes: positions } = layoutDag(nodes as readonly DagNode<never>[], edges, {
        direction: `LR`,
        nodeWidth: RUN_NODE_WIDTH,
        nodeHeight: RUN_NODE_HEIGHT,
    });
    const byX = new Map<number, string[]>();
    for (const node of nodes) {
        const x = positions.get(node.id)?.x ?? 0;
        byX.set(x, [...(byX.get(x) ?? []), node.id]);
    }
    const live = new Map(run.steps.filter((step) => ran(step.state)).map((step) => [step.stepId, step.conversationId]));
    const columns = new Map<string, RunColumn>();
    for (const stepIds of byX.values()) {
        // A `continue` step shares its predecessor's conversation; a column must not offer that chat twice.
        const seen = new Set<string>();
        const sessions = stepIds.flatMap((id): RunSession[] => {
            const conversationId = live.get(id);
            if (conversationId === undefined || seen.has(conversationId)) {
                return [];
            }
            seen.add(conversationId);
            return [sessionOf(run, id, conversationId)];
        });
        const column: RunColumn = { stepIds, sessions };
        for (const id of stepIds) {
            columns.set(id, column);
        }
    }
    return columns;
};
