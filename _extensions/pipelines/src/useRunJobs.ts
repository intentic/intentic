import { type CiJobsResponse, CiJobsResponseSchema, isPipelineInFlight, type PipelineJob, type PipelineRun } from "@intentic/sandbox-contract";
import { useQuery } from "@tanstack/vue-query";
import { computed, type Ref, watch } from "vue";
import { host } from "./host";

/* Lazily fetches ALL jobs for a single pipeline run when `enabled` flips on (the user expanded that row). */

// Beat for a run still going: the row is being watched, and a graph that never moves reads as a stuck pipeline.
// One vendor call a beat, since the daemon holds the run's workflow source (providers.ts).
const POLL_MS = 15_000;
// A settled run's jobs never move again, so this bounds only a remount or a window regaining focus.
const SETTLED_STALE_MS = 60_000;

/** How often this run's jobs are worth re-reading; `false` is a run that has ended, whose graph is final. */
export const jobsPollMs = (run: PipelineRun | undefined): number | false => (run !== undefined && isPipelineInFlight(run.status) ? POLL_MS : false);

export function useRunJobs(run: Ref<PipelineRun | undefined>) {
    const api = host();
    const queryKey = computed(() => api.sandbox.key(`ci-jobs`, run.value?.repo ?? ``, String(run.value?.runId ?? ``)));
    const enabled = computed(() => run.value !== undefined && api.sandbox.reachable());
    const inFlight = computed(() => run.value !== undefined && isPipelineInFlight(run.value.status));

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
        refetchInterval: computed(() => jobsPollMs(run.value)),
        staleTime: computed(() => (inFlight.value ? 0 : SETTLED_STALE_MS)),
    });

    // The run settles between beats, so the last beat's list is one job short of the final one; this is that read.
    watch(inFlight, (now, before) => {
        if (before === true && !now && run.value !== undefined) {
            void query.refetch();
        }
    });

    return {
        jobs: computed((): PipelineJob[] => query.data.value?.jobs ?? []),
        isLoading: query.isLoading,
        error: computed(() => query.error.value?.message),
    };
}
