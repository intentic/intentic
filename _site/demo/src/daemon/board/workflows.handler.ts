import {
    allRuns,
    archiveWorkflowRun,
    removeWorkflow,
    rotateGateToken,
    saveWorkflow,
    startWorkflowRun,
    stopWorkflowRun,
    unarchiveWorkflowRun,
    workflowList,
} from "./workflowRuns";
import { type Doors, okAfter } from "../doors";

// The designs and their runs over the workflow store (daemon/workflowRuns.ts): a run started here plays its steps with
// a card per conversation, and every write changes what the next read says.
export const workflowsDoors = {
    list: () => ({ workflows: workflowList(Date.now()) }),
    runs: () => ({ runs: allRuns(Date.now()) }),
    save: ({ workflow, create }) => saveWorkflow(workflow, create),
    rotateGateToken: ({ id }) => rotateGateToken(id),
    remove: ({ id }) => okAfter(() => removeWorkflow(id)),
    run: ({ id, request }) => startWorkflowRun(id, request),
    stopRun: ({ runId }) => okAfter(() => stopWorkflowRun(runId)),
    archiveRun: ({ runId }) => okAfter(() => archiveWorkflowRun(runId)),
    unarchiveRun: ({ runId }) => okAfter(() => unarchiveWorkflowRun(runId)),
} satisfies Doors<`workflows`>;
