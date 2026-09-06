import { layoutDag } from "@intentic/ui";
import type { DagNode } from "@intentic/ui";
import { workflowDag } from "@intentic/ext-workflows";
import type { WorkflowRun, WorkflowStepRun } from "@intentic/sandbox-contract";
import { type RunColumn, type RunSession, sessionOf } from "./chatRun";

/* THE DIAGRAM'S COLUMNS, the one part of the run machinery that needs the dag layout, split from chatRun so
 * the run STATE stays importable from anywhere (the summons channel reaches it from every window) without
 * dragging the UI component library into that module graph. Only the diagram draws columns, and only it
 * imports this. */

/* THE NODE GEOMETRY, here rather than in the diagram component, because two things have to agree about it: the graph
 * the user clicks and the columns this file computes from the same layout. A node size passed to one and not
 * the other would put the seam between columns somewhere nobody can see.
 */
export const RUN_NODE_WIDTH = 216;
export const RUN_NODE_HEIGHT = 62;

/* WHICH STEP STATES HAVE A SESSION BEHIND THEM, and the distinction the diagram was getting wrong.
 *
 * `skipped` is the one that matters and the one that looks like it should qualify: it is not a step that ran
 * and failed, it is a step that NEVER STARTED because something upstream did not finish. Its conversation id
 * is derived (wf-<run>-<step>) and written into the record before the run begins, so it exists as a string
 * long before, and, for a skipped step, forever without, anything opening it. Treating those ids as sessions
 * is why clicking most of a failed run's diagram did nothing at all: every node offered a chat that had never
 * been created, the fleet had no card for it, and the click resolved to an empty set in silence.
 *
 * `pending` is the same fact one step earlier. Everything else, running, done, failed, stopped, took at
 * least one turn, which means a transcript.
 */
const ran = (state: WorkflowStepRun["state"]): boolean => state !== `pending` && state !== `skipped`;

/* The run's steps grouped into the columns the diagram DRAWS, keyed by step id.
 *
 * Grouped on the laid-out x rather than on dependency depth, and the difference is not academic: dagre ranks
 * with network simplex, so a step whose only dependency finished three columns back is drawn beside the work
 * it feeds and not beside the work it waited for. Computing "depth" here instead would be a second opinion
 * about a picture the user is looking at, and the first time the two disagreed the click would open a column
 * other than the one under the pointer.
 */
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
        // A `continue` step shares its predecessor's conversation, so a column holding both must not open the
        // same chat twice, the pane set is a set, and asking for two of one would silently be one.
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
