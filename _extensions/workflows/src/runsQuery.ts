import { type WorkflowRun, WorkflowRunsListSchema } from "@intentic/sandbox-contract";
import type { HostQuery } from "@intentic/extension-api";
import { host } from "./host";

// Ledger shared by the workflows page and the rail badge's poll; one key and parser so whichever reads first fills the
// entry the other paints from. Keyed `workflow-runs` to match the daemon's own file-push invalidation (core's
// WORKSPACE_STATE_FILES), so a scheduler write needs no polling here.
// Only `running` counts as happening now; every other state is an ending. This number is both the rail badge and what
// seats the tile.
export const runningOf = (runs: readonly WorkflowRun[]): number => runs.filter((run) => run.state === `running`).length;

export const workflowRunsQuery = (): HostQuery<WorkflowRun[]> => {
    const api = host();
    return {
        queryKey: api.sandbox.key(`workflow-runs`),
        queryFn: async (): Promise<WorkflowRun[]> => WorkflowRunsListSchema.parse(await api.sandbox.json(`/workflows/runs`)).runs,
    };
};
