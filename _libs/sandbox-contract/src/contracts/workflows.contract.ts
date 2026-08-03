import { oc } from "@orpc/contract";
import {
    OkSchema,
    WorkflowIdParamSchema,
    WorkflowRunIdParamSchema,
    WorkflowRunSchema,
    WorkflowRunsListSchema,
    WorkflowRunStartSchema,
    WorkflowSchema,
    WorkflowsListSchema,
} from "../schemas.js";

/* The workflow routes — "run these sessions, in this order, each handing its result to the next".
 *
 * SPLIT LIKE AUTOMATIONS, NOT LIKE LOOPS, and the split says what a workflow is. A loop has no editor because
 * it is started against a conversation and then it is history; a workflow is a DESIGN — a thing the user
 * authors once, keeps, edits, and runs repeatedly — so it gets the manifest treatment: upsert by id, delete,
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
    /* Create or replace a workflow, by id. Refuses a graph that cannot run — a cycle, a `needs` naming a step
     * that is not there, a step with no way to know it is finished — with the same sentences the designer shows
     * while you type (see workflowFaults). Validation lives in the contract precisely so those two can never
     * disagree about what is legal. */
    save: oc.route({ method: "POST", path: "/workflows" }).input(WorkflowSchema).output(WorkflowSchema),
    // Deleting a workflow does NOT stop a run of it that is in flight, and does not delete its history: the run
    // snapshotted its definition when it started, so it stays readable and stays stoppable.
    remove: oc.route({ method: "DELETE", path: "/workflows/{id}" }).input(WorkflowIdParamSchema).output(OkSchema),
    /* Start a run, optionally pointed at a request — the sentence the user typed in the composer, which every
     * step is handed on top of its own prompt. Every step is recorded `pending` up front, so the graph is
     * complete from the first frame and a missing node never has to mean two things. Several runs of one
     * workflow may be in flight at once — they derive different conversation ids, so nothing is shared and
     * nothing can collide, which is what makes "run this design again on a different question" free. */
    run: oc.route({ method: "POST", path: "/workflows/{id}/run" }).input(WorkflowRunStartSchema).output(WorkflowRunSchema),
    // Every run across every workflow, newest first — the history the run view opens onto, and the only place a
    // deleted workflow's runs are still reachable.
    runs: oc.route({ method: "GET", path: "/workflows/runs" }).output(WorkflowRunsListSchema),
    /* Stop a run: no step that has not started will start, and the steps in flight stop after their current
     * ITERATION rather than being killed. Same split as stopping a loop, for the same reason — a step on
     * iteration 6 doing good work should be able to be its own last one. Killing the work outright is
     * /agent/stop on that step's conversation, which the run view links to per node.
     */
    stopRun: oc.route({ method: "POST", path: "/workflows/runs/{runId}/stop" }).input(WorkflowRunIdParamSchema).output(OkSchema),
};
