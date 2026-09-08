import {
    type DoorToken,
    DoorTokenSchema,
    type Workflow,
    type WorkflowRun,
    type WorkflowSaved,
    WorkflowSavedSchema,
    type WorkflowSummary,
    WorkflowsListSchema,
} from "@intentic/sandbox-contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/vue-query";
import { computed } from "vue";
import { host } from "./host";
import { workflowRunsQuery } from "./runsQuery";

// Workflow manifest and run ledger, via the daemon's /workflows routes. Not polled: both files ride the daemon's
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
        queryFn: async (): Promise<WorkflowSummary[]> => WorkflowsListSchema.parse(await api.sandbox.json(`/workflows`)).workflows,
        enabled,
    });
    const runsQuery = useQuery({ ...runs, enabled });

    const invalidate = async (): Promise<void> => {
        await queryClient.invalidateQueries({ queryKey });
        await queryClient.invalidateQueries({ queryKey: runsKey });
    };

    // Response includes the gate token when one exists; it's the designer's only way to learn the URL.
    const save = useMutation({
        mutationFn: async ({ workflow, create }: { workflow: Workflow; create: boolean }): Promise<WorkflowSaved> =>
            WorkflowSavedSchema.parse(
                await api.sandbox.json(`/workflows`, {
                    method: `POST`,
                    headers: { "content-type": `application/json` },
                    body: JSON.stringify({ workflow, create }),
                }),
            ),
        onSuccess: invalidate,
    });
    // Mints a fresh token and retires the old one at once; every wired pipeline must be re-taught.
    const rotateGateToken = useMutation({
        mutationFn: async (id: string): Promise<DoorToken> =>
            DoorTokenSchema.parse(await api.sandbox.json(`/workflows/${encodeURIComponent(id)}/gate/rotate`, { method: `POST` })),
        onSuccess: invalidate,
    });
    const remove = useMutation({
        mutationFn: (id: string) => api.sandbox.json(`/workflows/${encodeURIComponent(id)}`, { method: `DELETE` }),
        onSuccess: invalidate,
    });
    // Success means started, not finished; steps come back `pending` so the run view opens immediately.
    // `request` is what the user typed before Run, handed to every step on top of its own prompt.
    const start = useMutation({
        mutationFn: async ({ id, request }: { id: string; request?: string }): Promise<WorkflowRun> =>
            (await api.sandbox.json(`/workflows/${encodeURIComponent(id)}/run`, {
                method: `POST`,
                headers: { "content-type": `application/json` },
                body: JSON.stringify(request === undefined ? {} : { request }),
            })) as WorkflowRun,
        onSuccess: invalidate,
    });
    const stop = useMutation({
        mutationFn: (runId: string) => api.sandbox.json(`/workflows/runs/${encodeURIComponent(runId)}/stop`, { method: `POST` }),
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
