import type { DoorToken, Workflow, WorkflowRun, WorkflowSaved, WorkflowSummary } from "@intentic/sandbox-contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/vue-query";
import { computed } from "vue";
import { host } from "./host";
import { workflowRunsQuery } from "./runsQuery";

// Workflow manifest and run ledger, via the daemon's `workflows` procedures. Not polled: both files ride the daemon's
// file-change push, which invalidates the `workflows`/`workflow-runs` keys directly, so there's nothing an interval
// would discover between writes that the push hasn't already delivered.

export function useWorkflows() {
    const api = host();
    const queryClient = useQueryClient();
    const queryKey = api.sandbox.key(`workflows`);
    // Shared with the rail badge's poll; whichever asks first fills the entry the other paints from.
    const runs = workflowRunsQuery();
    const runsKey = runs.queryKey;
    const enabled = computed(() => api.sandbox.reachable());

    const query = useQuery({
        queryKey,
        queryFn: async (): Promise<WorkflowSummary[]> => (await api.sandbox.rpc.workflows.list()).workflows,
        enabled,
    });
    const runsQuery = useQuery({ ...runs, enabled });

    const invalidate = async (): Promise<void> => {
        await queryClient.invalidateQueries({ queryKey });
        await queryClient.invalidateQueries({ queryKey: runsKey });
    };

    // Response includes the gate token when one exists; it's the designer's only way to learn the URL.
    const save = useMutation({
        mutationFn: (input: { workflow: Workflow; create: boolean }): Promise<WorkflowSaved> => api.sandbox.rpc.workflows.save(input),
        onSuccess: invalidate,
    });
    // Mints a fresh token and retires the old one at once; every wired pipeline must be re-taught.
    const rotateGateToken = useMutation({
        mutationFn: (id: string): Promise<DoorToken> => api.sandbox.rpc.workflows.rotateGateToken({ id }),
        onSuccess: invalidate,
    });
    const remove = useMutation({
        mutationFn: (id: string) => api.sandbox.rpc.workflows.remove({ id }),
        onSuccess: invalidate,
    });
    // Success means started, not finished; steps come back `pending` so the run view opens immediately.
    // `request` is what the user typed before Run, handed to every step on top of its own prompt.
    const start = useMutation({
        mutationFn: (input: { id: string; request?: string }): Promise<WorkflowRun> => api.sandbox.rpc.workflows.run(input),
        onSuccess: invalidate,
    });
    const stop = useMutation({
        mutationFn: (runId: string) => api.sandbox.rpc.workflows.stopRun({ runId }),
        onSuccess: invalidate,
    });

    return {
        workflows: computed<WorkflowSummary[]>(() => query.data.value ?? []),
        runs: computed<WorkflowRun[]>(() => runsQuery.data.value ?? []),
        // Whether the ledger has actually loaded, since an empty `runs` means both that and still-loading.
        runsLoaded: runsQuery.isSuccess,
        error: computed(() => query.error.value?.message ?? runsQuery.error.value?.message),
        isLoading: query.isLoading,
        save,
        rotateGateToken,
        remove,
        start,
        stop,
    };
}
