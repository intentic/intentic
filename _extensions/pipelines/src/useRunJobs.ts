import { type CiJobsResponse, CiJobsResponseSchema, type PipelineJob, type PipelineRun } from "@intentic/sandbox-contract";
import { useQuery } from "@tanstack/vue-query";
import { computed, type Ref } from "vue";
import { host } from "./host";

/* Lazily fetches ALL jobs for a single pipeline run when `enabled` flips on (the user expanded that row).
 * Not polled, the run's terminal state is stable and the cost of one extra call per expand is negligible. */

export function useRunJobs(run: Ref<PipelineRun | undefined>) {
    const api = host();
    const queryKey = computed(() => api.sandbox.key(`ci-jobs`, run.value?.repo ?? ``, String(run.value?.runId ?? ``)));
    const enabled = computed(() => run.value !== undefined && api.sandbox.reachable());

    const query = useQuery({
        queryKey,
        queryFn: async (): Promise<CiJobsResponse> => {
            const r = run.value!;
            return CiJobsResponseSchema.parse(
                await api.sandbox.json(`/ci/runs/jobs`, {
                    method: `POST`,
                    headers: { "content-type": `application/json` },
                    body: JSON.stringify({ repo: r.repo, runId: r.runId }),
                }),
            );
        },
        enabled,
        staleTime: 60_000,
    });

    return {
        jobs: computed((): PipelineJob[] => query.data.value?.jobs ?? []),
        isLoading: query.isLoading,
        error: computed(() => query.error.value?.message),
    };
}
