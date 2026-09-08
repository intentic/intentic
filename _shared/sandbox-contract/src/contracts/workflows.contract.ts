import { oc } from "@orpc/contract";
import { DoorTokenSchema, OkSchema } from "../schemas/shared.js";
import {
    WorkflowIdParamSchema,
    WorkflowRunIdParamSchema,
    WorkflowRunSchema,
    WorkflowRunsListSchema,
    WorkflowRunStartSchema,
    WorkflowSaveSchema,
    WorkflowsListSchema,
    WorkflowSavedSchema,
} from "../schemas/workflows.js";

// Workflow routes: run these sessions in order, each handing its result to the next. Manifest treatment (create/update,
// delete, list), like automations not loops, since a workflow is authored once and run repeatedly.
// No `enabled` toggle: nothing fires a workflow on its own, only an explicit run.
// `run` acks with the run as recorded and executes detached, the same contract every turn-starting route here keeps.
export const workflowsContract = {
    // Every saved workflow with its run history, newest first; a never-run workflow isn't an error case.
    list: oc
        .route({
            method: "GET",
            path: "/workflows",
            summary: "Saved workflows and their runs",
            description:
                "Every workflow somebody has designed, each with its own run history, newest first. One answer rather than two, because a workflow that has never been run is the interesting case rather than a mistake.",
        })
        .output(WorkflowsListSchema),
    // Create or replace, with the operation explicit so an id collision can't turn a create into an overwrite.
    // Refuses a graph that can't run (a cycle, an unmet `needs`, a step with no completion signal), in the same words
    // the design-time validator (workflowFaults) uses.
    save: oc
        .route({
            method: "POST",
            path: "/workflows",
            summary: "Create or replace a workflow",
            description:
                "Writes a workflow design. Say which of the two you mean, so an id that happens to collide cannot silently overwrite somebody's work. A design that could never run is refused, in the same words the editor shows while you type: a loop in the steps, a step waiting on one that is not there, a step with no way of knowing it is finished.",
        })
        .input(WorkflowSaveSchema)
        .output(WorkflowSavedSchema),
    // Mints a new gate credential; every pipeline holding the old URL stops working the moment this answers.
    rotateGateToken: oc
        .route({
            method: "POST",
            path: "/workflows/{id}/gate/rotate",
            summary: "Rotate a release gate's token",
            description:
                "Mints a new credential for the workflow's release gate and retires the old one at once. Every pipeline wired to the gate has to be handed the new URL. Refused for a workflow that declares no gate.",
        })
        .input(WorkflowIdParamSchema)
        .output(DoorTokenSchema),
    // Deleting a workflow doesn't stop or erase an in-flight run: a run snapshots its definition at start.
    remove: oc
        .route({
            method: "DELETE",
            path: "/workflows/{id}",
            summary: "Delete a workflow",
            description:
                "Removes the design. A run of it that is already going keeps going and stays readable and stoppable, because a run takes its own copy of the design when it starts.",
        })
        .input(WorkflowIdParamSchema)
        .output(OkSchema),
    // Starts a run, optionally with a request appended to every step's own prompt; each step is recorded `pending` up
    // front so the graph is complete from the first frame.
    // Multiple runs of one workflow can be in flight at once; each derives its own conversation ids, so none collide.
    run: oc
        .route({
            method: "POST",
            path: "/workflows/{id}/run",
            summary: "Start a workflow",
            description:
                "Kicks a workflow off and answers immediately with the run as recorded; the work carries on without you. Point it at a question and every step gets that on top of its own instructions. Every step is written down as waiting up front, so the picture is complete from the first frame. Several runs of one design can be in flight at once without colliding.",
        })
        .input(WorkflowRunStartSchema)
        .output(WorkflowRunSchema),
    // Every run across every workflow, newest first; the only place a deleted workflow's runs are still reachable.
    runs: oc
        .route({
            method: "GET",
            path: "/workflows/runs",
            summary: "Every workflow run",
            description:
                "All runs across all workflows, newest first. This is also the only place the runs of a deleted workflow are still reachable.",
        })
        .output(WorkflowRunsListSchema),
    // Cuts off in-flight steps where they stand, aborting their turns like /agent/stop; not the graceful
    // finish-the-iteration stop a loop performs, since a step is a whole agent turn.
    // Always ends the run, including one left `running` by a daemon that was replaced mid-flight.
    stopRun: oc
        .route({
            method: "POST",
            path: "/workflows/runs/{runId}/stop",
            summary: "Stop a run now",
            description:
                "Nothing further starts, and the steps already going are cut off where they stand. Whatever they had written stays on their branches. Deliberately abrupt rather than letting the current step finish: a step is a whole agent turn, and a stop that kept spending for minutes afterwards is indistinguishable from a button that does nothing. It always ends the run, including one left stranded by a daemon that was replaced mid-flight.",
        })
        .input(WorkflowRunIdParamSchema)
        .output(OkSchema),
    // Ends a run's board presence, the run's half of `agents.archive`: nothing is lost, checkouts are reclaimed, and
    // `unarchiveRun` reverses it. Refused while the run is going.
    // Archives every step that ran along with it, since a step has no card of its own; the run's row stands for it.
    archiveRun: oc
        .route({
            method: "POST",
            path: "/workflows/runs/{runId}/archive",
            summary: "Take a finished run off the board",
            description:
                "Nothing is lost and the working copies are reclaimed. Every conversation the run started is put away with it, which is what makes this an archive rather than a dismissal: a step has no card of its own, so merely dropping the run would spill its conversations onto the board at the moment somebody said they were done. Refused while the run is still going.",
        })
        .input(WorkflowRunIdParamSchema)
        .output(OkSchema),
    // Inverse of archiveRun: puts an archived run and its sessions back on the board.
    unarchiveRun: oc
        .route({
            method: "POST",
            path: "/workflows/runs/{runId}/unarchive",
            summary: "Bring an archived run back",
            description: "Puts a run and every conversation it started back on the board.",
        })
        .input(WorkflowRunIdParamSchema)
        .output(OkSchema),
};
