import { type CiJobsResponse, isPipelineInFlight, type PipelineJob, type PipelineRun } from "@intentic/sandbox-contract/schemas/ci";
import { hashKey, useQueryClient } from "@tanstack/vue-query";
import { computed, onScopeDispose, type Ref, watch } from "vue";
import { ciRunsQuery } from "./ciRunsQuery";
import { host } from "./host";

/* Lazily fetches ALL jobs for a single pipeline run when `enabled` flips on (the user expanded that row). */

// Beat for a run still going: the row is being watched, and a graph that never moves reads as a stuck pipeline.
// One vendor call a beat, since the daemon holds the run's workflow source (providers.ts). Only the fallback now
// (2026-10-20): every webhook delivery, a job's phase included, pushes `ci`, the board re-reads its runs, and an open
// in-flight row re-reads its graph off that (boardLanded below). The beat is what a repo whose hook is silent waits out.
const POLL_MS = 45_000;
// A settled run's jobs never move again, so this bounds only a remount or a window regaining focus.
const SETTLED_STALE_MS = 60_000;

/** How often this run's jobs are worth re-reading; `false` is a run that has ended, whose graph is final. */
export const jobsPollMs = (run: PipelineRun | undefined): number | false => (run !== undefined && isPipelineInFlight(run.status) ? POLL_MS : false);

// What boardLanded reads of a query cache event, which carries far more.
interface CacheEvent {
    readonly type: string;
    readonly action?: { readonly type: string };
    readonly query: { readonly queryHash: string };
}

/** Whether a query cache event is the board's runs landing fresh: the moment an open in-flight row re-reads its jobs. */
export const boardLanded = (event: CacheEvent, runsHash: string): boolean =>
    event.type === `updated` && event.action?.type === `success` && event.query.queryHash === runsHash;

export function useRunJobs(run: Ref<PipelineRun | undefined>) {
    const api = host();
    const queryKey = computed(() =>
        run.value === undefined ? api.sandbox.readKey(`ci.jobs`) : api.sandbox.readKey(`ci.jobs`, { repo: run.value.repo, runId: run.value.runId }),
    );
    const enabled = computed(() => run.value !== undefined);
    const inFlight = computed(() => run.value !== undefined && isPipelineInFlight(run.value.status));

    const { query, error } = api.sandbox.query({
        queryKey,
        queryFn: (): Promise<CiJobsResponse> => {
            const r = run.value!;
            return api.sandbox.rpc.ci.jobs({ repo: r.repo, runId: r.runId });
        },
        enabled,
        refetchInterval: computed(() => jobsPollMs(run.value)),
        staleTime: computed(() => (inFlight.value ? 0 : SETTLED_STALE_MS)),
    });

    // The board re-reads on every `ci` push; the runtime-state binding names runs only, since a frame does not say which
    // run moved and a settled row's graph is final. So an in-flight row follows the board here rather than being
    // invalidated by the push itself: one read per open in-flight row per landing, none for a settled one.
    const queryClient = useQueryClient();
    const runsHash = hashKey(ciRunsQuery().queryKey);
    const stopFollowing = queryClient.getQueryCache().subscribe((event) => {
        if (inFlight.value && boardLanded(event, runsHash)) {
            void query.refetch();
        }
    });
    onScopeDispose(stopFollowing);

    // The run settles between beats, so the last beat's list is one job short of the final one; this is that read.
    watch(inFlight, (now, before) => {
        if (before === true && !now && run.value !== undefined) {
            void query.refetch();
        }
    });

    return {
        jobs: computed((): PipelineJob[] => query.data.value?.jobs ?? []),
        isLoading: query.isLoading,
        error,
    };
}
