import { type WorkflowRun, WorkflowRunsListSchema } from "@intentic/sandbox-contract";
import type { HostQuery } from "@intentic/extension-api";
import { host } from "./host";

/* THE RUN LEDGER, named once for both of its readers: the workflows page and the rail badge's background poll
 * (attention.ts). One sandbox-scoped key and one parser, so whichever asks first fills the entry the other
 * paints from, rather than the badge quietly warming a copy the view never sees.
 *
 * The key is `workflow-runs` because that is what the daemon's file push already invalidates: core owns the
 * WORKSPACE_STATE_FILES entry for the ledger (the fleet board reads runs whether or not this extension is on),
 * so the scheduler writing a step's outcome moves this without anything here polling for it. */
/* WHAT COUNTS AS THIS WORKSPACE STILL WORKING. `running` is the only run state that is happening now: `done`,
 * `failed`, `stopped`, `overspent` and `error` are all endings, and an ending is history the moment it lands.
 * The rail badge is this number, and so is the seat the tile holds while a fan-out is in flight (attention.ts). */
export const runningOf = (runs: readonly WorkflowRun[]): number => runs.filter((run) => run.state === `running`).length;

export const workflowRunsQuery = (): HostQuery<WorkflowRun[]> => {
    const api = host();
    return {
        queryKey: api.sandbox.key(`workflow-runs`),
        queryFn: async (): Promise<WorkflowRun[]> => WorkflowRunsListSchema.parse(await api.sandbox.json(`/workflows/runs`)).runs,
    };
};
