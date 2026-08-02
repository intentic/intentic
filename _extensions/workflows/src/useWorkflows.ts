import { type Workflow, type WorkflowRun, WorkflowRunsListSchema, type WorkflowSummary, WorkflowsListSchema } from "@intentic/sandbox-contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/vue-query";
import { computed } from "vue";
import { host } from "./host";

/* The sandbox's workflow manifest (.intentic/workflows.json) and run ledger (.intentic/workflow-runs.json),
 * read/written through the daemon's /workflows routes. All daemon access goes through the host api.
 *
 * POLLED WHILE ANYTHING IS RUNNING, and only then. A workflow run is the longest-lived thing in the product —
 * a step is a loop and a loop is many turns — and there is no push channel that announces "step 3 of 7 just
 * finished". The manifest's `files` contributions invalidate on the daemon writing either file, which covers
 * most of it; the poll is what covers the gap while a single step grinds for ten minutes and the graph should
 * still be showing its iteration count moving. Idle, it costs nothing: no run in flight, no interval.
 */

// Fast enough that a finished step lights up while you are still looking at it, slow enough to be free.
const LIVE_POLL_MS = 4_000;

export function useWorkflows() {
    const api = host();
    const queryClient = useQueryClient();
    const queryKey = api.sandbox.key(`workflows`);
    const runsKey = api.sandbox.key(`workflow-runs`);
    const enabled = computed(() => api.sandbox.reachable());

    const query = useQuery({
        queryKey,
        queryFn: async (): Promise<WorkflowSummary[]> => WorkflowsListSchema.parse(await api.sandbox.json(`/workflows`)).workflows,
        enabled,
    });
    const runsQuery = useQuery({
        queryKey: runsKey,
        queryFn: async (): Promise<WorkflowRun[]> => WorkflowRunsListSchema.parse(await api.sandbox.json(`/workflows/runs`)).runs,
        enabled,
        // Read off the query handed in rather than off `runsQuery` — naming the query inside its own options
        // is a cycle, and the honest reading is that the interval is a function of the DATA.
        refetchInterval: (current) => (current.state.data?.some((run) => run.state === `running`) === true ? LIVE_POLL_MS : false),
    });

    const invalidate = async (): Promise<void> => {
        await queryClient.invalidateQueries({ queryKey });
        await queryClient.invalidateQueries({ queryKey: runsKey });
    };

    const save = useMutation({
        mutationFn: (workflow: Workflow) =>
            api.sandbox.json(`/workflows`, {
                method: `POST`,
                headers: { "content-type": `application/json` },
                body: JSON.stringify(workflow),
            }),
        onSuccess: invalidate,
    });
    const remove = useMutation({
        mutationFn: (id: string) => api.sandbox.json(`/workflows/${encodeURIComponent(id)}`, { method: `DELETE` }),
        onSuccess: invalidate,
    });
    // The daemon acks with the opened run and executes detached, so success here means "it started". The run
    // that comes back is already complete as a graph — every step recorded `pending` — which is what lets the
    // run view open on it immediately rather than on a spinner.
    const start = useMutation({
        mutationFn: async (id: string): Promise<WorkflowRun> =>
            (await api.sandbox.json(`/workflows/${encodeURIComponent(id)}/run`, { method: `POST` })) as WorkflowRun,
        onSuccess: invalidate,
    });
    const stop = useMutation({
        mutationFn: (runId: string) => api.sandbox.json(`/workflows/runs/${encodeURIComponent(runId)}/stop`, { method: `POST` }),
        onSuccess: invalidate,
    });

    return {
        workflows: computed<WorkflowSummary[]>(() => query.data.value ?? []),
        runs: computed<WorkflowRun[]>(() => runsQuery.data.value ?? []),
        error: computed(() => query.error.value?.message ?? runsQuery.error.value?.message),
        isLoading: query.isLoading,
        save,
        remove,
        start,
        stop,
    };
}
