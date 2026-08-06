import { type Workflow, type WorkflowRun, WorkflowRunsListSchema, type WorkflowSummary, WorkflowsListSchema } from "@intentic/sandbox-contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/vue-query";
import { computed } from "vue";
import { host } from "./host";

/* The sandbox's workflow manifest (.intentic/workflows.json) and run ledger (.intentic/workflow-runs.json),
 * read/written through the daemon's /workflows routes. All daemon access goes through the host api.
 *
 * NOT POLLED. Both files are on the daemon's file-change push — the scheduler writes the ledger several times
 * per step, the watcher batches each write into a `workspaceChanged` frame, and the browser invalidates the
 * `workflows` / `workflow-runs` keys (core's WORKSPACE_STATE_FILES table; core owns those keys because the
 * fleet board reads them whether or not this extension is enabled). Between writes nothing about a run
 * changes, so there is nothing for an interval to discover — a poll here could only re-read the answer the
 * push already delivered, seconds later.
 */

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
    });

    const invalidate = async (): Promise<void> => {
        await queryClient.invalidateQueries({ queryKey });
        await queryClient.invalidateQueries({ queryKey: runsKey });
    };

    const save = useMutation({
        mutationFn: ({ workflow, create }: { workflow: Workflow; create: boolean }) =>
            api.sandbox.json(`/workflows`, {
                method: `POST`,
                headers: { "content-type": `application/json` },
                body: JSON.stringify({ workflow, create }),
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
    /* The request rides with the start — the sentence the user typed before pressing Run, which every step is
     * handed on top of its own prompt (WorkflowRun.request). It is what makes a saved design a SHAPE you point
     * at today's job rather than a document you edit to ask a question. */
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
        // Whether the LEDGER has actually been read, as opposed to being empty or still in flight. Only a
        // surface that has to tell "this run is not on the record" apart from "the record has not arrived"
        // needs it — an empty `runs` means both, and guessing wrong accuses a link of being broken while it
        // is still loading.
        runsLoaded: runsQuery.isSuccess,
        error: computed(() => query.error.value?.message ?? runsQuery.error.value?.message),
        isLoading: query.isLoading,
        save,
        remove,
        start,
        stop,
    };
}
