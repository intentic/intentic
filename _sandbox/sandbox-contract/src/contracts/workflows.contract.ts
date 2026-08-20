import { oc } from "@orpc/contract";
import {
    OkSchema,
    WorkflowIdParamSchema,
    WorkflowRunIdParamSchema,
    WorkflowRunSchema,
    WorkflowRunsListSchema,
    WorkflowRunStartSchema,
    WorkflowSaveSchema,
    WorkflowSchema,
    WorkflowsListSchema,
} from "../schemas.js";

/* The workflow routes, "run these sessions, in this order, each handing its result to the next".
 *
 * SPLIT LIKE AUTOMATIONS, NOT LIKE LOOPS, and the split says what a workflow is. A loop has no editor because
 * it is started against a conversation and then it is history; a workflow is a DESIGN, a thing the user
 * authors once, keeps, edits, and runs repeatedly, so it gets the manifest treatment: create/update, delete,
 * list. What it does not get is an `enabled` toggle, because nothing fires it on its own: a workflow runs when
 * somebody (or an automation's prompt) says run it.
 *
 * `run` acks with the run as recorded and executes detached, the contract every turn-starting route here
 * keeps. The first step alone can take minutes and the run may take hours; the run view is where it is watched,
 * and the fleet board shows its steps as the ordinary agents they are.
 */
export const workflowsContract = {
    // Every saved workflow with its run history, newest run first. One route rather than two because the list
    // page shows both and a workflow with no runs is the interesting case, not an error.
    list: oc.route({ method: "GET", path: "/workflows" }).output(WorkflowsListSchema),
    /* Create or replace a workflow, with the operation made explicit so an accidental id collision cannot turn
     * a create into replacement. Refuses a graph that cannot run, a cycle, a `needs` naming a step
     * that is not there, a step with no way to know it is finished, with the same sentences the designer shows
     * while you type (see workflowFaults). Validation lives in the contract precisely so those two can never
     * disagree about what is legal. */
    save: oc.route({ method: "POST", path: "/workflows" }).input(WorkflowSaveSchema).output(WorkflowSchema),
    // Deleting a workflow does NOT stop a run of it that is in flight, and does not delete its history: the run
    // snapshotted its definition when it started, so it stays readable and stays stoppable.
    remove: oc.route({ method: "DELETE", path: "/workflows/{id}" }).input(WorkflowIdParamSchema).output(OkSchema),
    /* Start a run, optionally pointed at a request, the sentence the user typed in the composer, which every
     * step is handed on top of its own prompt. Every step is recorded `pending` up front, so the graph is
     * complete from the first frame and a missing node never has to mean two things. Several runs of one
     * workflow may be in flight at once, they derive different conversation ids, so nothing is shared and
     * nothing can collide, which is what makes "run this design again on a different question" free. */
    run: oc.route({ method: "POST", path: "/workflows/{id}/run" }).input(WorkflowRunStartSchema).output(WorkflowRunSchema),
    // Every run across every workflow, newest first, the history the run view opens onto, and the only place a
    // deleted workflow's runs are still reachable.
    runs: oc.route({ method: "GET", path: "/workflows/runs" }).output(WorkflowRunsListSchema),
    /* Stop a run: nothing that has not started will start, and the steps in flight are CUT OFF where they
     * are, their turns aborted exactly as /agent/stop aborts one, so whatever they had written stays on
     * their branches and the step settles as stopped.
     *
     * Not the graceful "finish the iteration you are on" a LOOP's stop performs, and the difference is the
     * unit: a loop's iteration is a round somebody is watching, a workflow step's is an entire agent turn.
     * Waiting for one meant a stopped run kept working, kept spending and kept asking questions for minutes
     * after the press, which is indistinguishable from a button that does nothing.
     *
     * IT ALWAYS ENDS THE RUN, including one no scheduler is behind, a record left `running` by a daemon that
     * was replaced mid-flight. That case used to be refused, which made the stuck run permanent: a Stop that
     * could not work, a step count that would never move, and no way off the board.
     */
    stopRun: oc.route({ method: "POST", path: "/workflows/runs/{runId}/stop" }).input(WorkflowRunIdParamSchema).output(OkSchema),
    /* Take an ENDED run off the board, the run's half of `agents.archive`, and the same bargain: nothing is
     * lost, the checkouts are reclaimed, and `unarchiveRun` puts it all back. It needs an exit of its own
     * because nothing about a run transitions once it is over, so a failed one would sit in Attention until
     * fifty more had rolled it off the ledger. Refused while the run is going.
     *
     * IT ARCHIVES THE STEPS WITH THE RUN, which is what makes it an archive rather than a dismissal. A step
     * has no card of its own, the run's row stands for it, so merely dropping the record released the run's
     * conversations onto the board as loose cards at the exact moment the user said they were done with the
     * job. Every step that ran is archived, on the same terms as pointing `agents.archive` at those ids: that
     * route archives what the user named without re-litigating whether each one was ready to go, and a run the
     * user has archived is exactly that gesture made once for the whole graph.
     */
    archiveRun: oc.route({ method: "POST", path: "/workflows/runs/{runId}/archive" }).input(WorkflowRunIdParamSchema).output(OkSchema),
    // Put an archived run and its sessions back on the board, the inverse of the above and the run's half of
    // `agents.unarchive`.
    unarchiveRun: oc.route({ method: "POST", path: "/workflows/runs/{runId}/unarchive" }).input(WorkflowRunIdParamSchema).output(OkSchema),
};
