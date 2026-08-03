import { layoutDag } from "@intentic/ui";
import type { DagNode } from "@intentic/ui";
import { workflowDag } from "@intentic/ext-workflows";
import type { AgentHarness, WorkflowRun, WorkflowStepRun } from "@intentic/sandbox-contract";
import { ref } from "vue";

/* A WORKFLOW RUN, INSIDE THE CHAT PANEL — the state behind "show me what this run is doing".
 *
 * WHY IT IS NOT A NAVIGATION. Opening a run used to send the main view to the workflows extension, which is
 * the wrong half of the screen: what a person wants from a live run is the SESSIONS, and sessions are chats.
 * Sending them to a page elsewhere meant leaving the panel that can show four transcripts at once in order to
 * look at a picture of them. So the run rides in the chat panel, which already knows how to put N conversations
 * side by side, and the picture is a mode of that panel rather than a different address.
 *
 * TWO MODES, AND THE BACK ARROW IS THE HINGE. `sessions` is the panes, which is where you land: the run's live
 * steps, one column each. `graph` is the diagram, one press back from them — the map you go to in order to
 * choose a different part of the run. It is the same relationship a folder has to a file, and the arrow points
 * the same way.
 *
 * The run itself is NOT held here, only its id: the ledger is polled (useWorkflowRuns) and a snapshot taken at
 * click time would freeze the graph at the moment it was opened — every node still `pending`, forever.
 */

export type ChatRunMode = "sessions" | "graph";

export interface ChatRunView {
    readonly runId: string;
    readonly mode: ChatRunMode;
}

export const chatRun = ref<ChatRunView | undefined>();

export const showRun = (runId: string, mode: ChatRunMode): void => {
    chatRun.value = { runId, mode };
};

export const closeRun = (): void => {
    chatRun.value = undefined;
};

// Every conversation this run drives, whether or not the step has started. A `continue` step shares its
// predecessor's, so this set is smaller than the step count.
const runHolds = (run: WorkflowRun, conversationId: string): boolean => run.steps.some((step) => step.conversationId === conversationId);

/* WHAT A FOCUS CHANGE DOES TO THE RUN ON SCREEN — the rule that keeps the diagram from being a trap.
 *
 * The diagram covers the panes, so while it is up every other way of choosing a chat — a card on the rail, a
 * card on the board, New agent, a deep link — moved the focus under a picture that did not move. The panel
 * looked frozen: the click landed, the panes behind it were reconciled, and none of it reached the screen.
 * Anything that moves the focus is therefore an exit from the diagram.
 *
 * WHERE IT EXITS TO is the honest reading of the gesture. A chat that belongs to this run means "show me this
 * part of it", so the run stays and the back arrow with it. Any other chat means the reader has left, and the
 * run goes with them rather than hanging a stale run's name over an unrelated transcript.
 *
 * A function rather than eight lines inside a watcher because this is the whole rule, and a rule that only
 * exists inside an SFC is one no test can reach.
 */
export const runOnFocus = (run: WorkflowRun, conversationId: string): ChatRunView | undefined =>
    runHolds(run, conversationId) ? { runId: run.runId, mode: `sessions` } : undefined;

/* THE NODE GEOMETRY, here rather than in the component, because two things have to agree about it: the graph
 * the user clicks and the columns this file computes from the same layout. A node size passed to one and not
 * the other would put the seam between columns somewhere nobody can see.
 */
export const RUN_NODE_WIDTH = 216;
export const RUN_NODE_HEIGHT = 62;

export interface RunSession {
    readonly conversationId: string;
    /* What the step's design pinned, for opening a conversation the fleet no longer lists. A step that ran
     * days ago has been swept off the roster, and its transcript is still there — so the seed only decides
     * which provider the composer opens on, and the daemon supplies everything that matters. Absent when the
     * step pinned nothing, which is most of them.
     */
    readonly agent: string | undefined;
    readonly harness: AgentHarness | undefined;
}

export interface RunColumn {
    // The steps dagre put at this depth — what the reader sees as one vertical band of the diagram.
    readonly stepIds: readonly string[];
    // The sessions behind them, deduped and in column order. Empty ⇒ nothing in this band ever ran, which is
    // what lets the diagram decline the click instead of swallowing it.
    readonly sessions: readonly RunSession[];
}

/* WHICH STEP STATES HAVE A SESSION BEHIND THEM, and the distinction the diagram was getting wrong.
 *
 * `skipped` is the one that matters and the one that looks like it should qualify: it is not a step that ran
 * and failed, it is a step that NEVER STARTED because something upstream did not finish. Its conversation id
 * is derived (wf-<run>-<step>) and written into the record before the run begins, so it exists as a string
 * long before — and, for a skipped step, forever without — anything opening it. Treating those ids as sessions
 * is why clicking most of a failed run's diagram did nothing at all: every node offered a chat that had never
 * been created, the fleet had no card for it, and the click resolved to an empty set in silence.
 *
 * `pending` is the same fact one step earlier. Everything else — running, done, failed, stopped — took at
 * least one turn, which means a transcript.
 */
const ran = (state: WorkflowStepRun["state"]): boolean => state !== `pending` && state !== `skipped`;

// One step run, as a session to open. Shared by every caller that turns part of a run into panes.
const sessionOf = (run: WorkflowRun, stepId: string, conversationId: string): RunSession => {
    const design = run.workflow.steps.find((step) => step.id === stepId);
    return { conversationId, agent: design?.agent, harness: design?.harness };
};

/* The sessions a run has ALIVE — where "open this run" lands before anyone has picked a column, and the count
 * its card reads "2 live" from. Deduped, because a `continue` step runs on its predecessor's conversation and
 * a run with two steps on one chat is showing one thing, not two.
 */
export const liveSessions = (run: WorkflowRun): RunSession[] => {
    const seen = new Set<string>();
    return run.steps.flatMap((step) => {
        if (step.state !== `running` || seen.has(step.conversationId)) {
            return [];
        }
        seen.add(step.conversationId);
        return [sessionOf(run, step.stepId, step.conversationId)];
    });
};

/* WHAT TO PUT ON SCREEN WHEN A RUN IS OPENED — its live sessions, or, in the seconds before any step has
 * registered one, the sessions it is ABOUT to open.
 *
 * The second half is what makes pressing Run feel like starting an agent. The daemon acks a run before a
 * single step has begun, so at that instant nothing is `running` and "open the run" had nothing to show but
 * the diagram — a picture of five boxes, when what the user just did was ask for work. The roots are the steps
 * with nothing to wait for, they are starting right now, and their conversation ids were written into the
 * record before the run began (that is what makes them addressable at all). So the panes open on the chats
 * that are about to fill, exactly as a new agent's tab opens before its first token.
 *
 * Only while the run is going: a finished run's roots are history, and the diagram is the right landing for
 * one of those.
 */
export const sessionsToOpen = (run: WorkflowRun): RunSession[] => {
    const live = liveSessions(run);
    if (live.length > 0 || run.state !== `running`) {
        return live;
    }
    const seen = new Set<string>();
    const roots = new Set(run.workflow.steps.filter((step) => step.needs.length === 0).map((step) => step.id));
    return run.steps.flatMap((step) => {
        if (!roots.has(step.stepId) || seen.has(step.conversationId)) {
            return [];
        }
        seen.add(step.conversationId);
        return [sessionOf(run, step.stepId, step.conversationId)];
    });
};

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
    const positions = layoutDag(nodes as readonly DagNode<never>[], edges, {
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
        // same chat twice — the pane set is a set, and asking for two of one would silently be one.
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
