import type { WorkflowRun } from "@intentic/sandbox-contract";
import type { HostQuery } from "@intentic/extension-api";
import { host } from "./host";

// Ledger shared by the workflows page, the rail badge's poll and the shell's own run list; one key and parser so
// whichever reads first fills the entry the others paint from. Keyed by its procedure, which the daemon's file push for
// the run ledger refreshes, so a scheduler write needs no polling here. The entry holds the whole answer; each reader
// takes `.runs` from it.
// Only `running` counts as happening now; every other state is an ending. This number is both the rail badge and what
// seats the tile.
export const runningOf = (runs: readonly WorkflowRun[]): number => runs.filter((run) => run.state === `running`).length;

// `workflows.runs`' answer; the contract names the schema, not its type.
export interface WorkflowRunsList {
    readonly runs: WorkflowRun[];
}

export const workflowRunsQuery = (): HostQuery<WorkflowRunsList> => {
    const api = host();
    return {
        queryKey: api.sandbox.readKey(`workflows.runs`),
        queryFn: () => api.sandbox.rpc.workflows.runs(),
    };
};
