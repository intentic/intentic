import { type CiJobsResponse, CiJobsResponseSchema, type PipelineRun } from "@intentic/sandbox-contract";
import { useQueries } from "@tanstack/vue-query";
import { computed, type Ref } from "vue";
import { failedOf, type JobFailureRun, recurringFailures } from "./failureHistory";
import { host } from "./host";

/* Which jobs keep breaking, across the runs on screen.
 *
 * Deliberately uses the SAME query keys as useRunJobs, so this shares vue-query's cache with the rows rather
 * than fetching anything twice — every visible row already loads its own jobs, and this is a second reader of
 * those same entries. Adding this view-level analysis costs no extra requests.
 */

export function useFailureHistory(runs: Ref<readonly PipelineRun[]>) {
    const api = host();

    // Only failed runs need their jobs fetched; a success has no failed jobs to name, and canceled/skipped are
    // not verdicts at all (see ciStreaks) so they neither extend nor break a streak.
    const terminal = computed(() => runs.value.filter((run) => run.status === `failed` || run.status === `success`));
    const failedRuns = computed(() => terminal.value.filter((run) => run.status === `failed`));

    const queries = useQueries({
        queries: computed(() =>
            failedRuns.value.map((run) => ({
                queryKey: api.sandbox.key(`ci-jobs`, run.repo, String(run.runId)),
                queryFn: async (): Promise<CiJobsResponse> =>
                    CiJobsResponseSchema.parse(
                        await api.sandbox.json(`/ci/runs/jobs`, {
                            method: `POST`,
                            headers: { "content-type": `application/json` },
                            body: JSON.stringify({ repo: run.repo, runId: run.runId }),
                        }),
                    ),
                enabled: api.sandbox.reachable(),
                staleTime: 60_000,
            })),
        ),
    });

    const history = computed((): JobFailureRun[] => {
        const jobsByRun = new Map<number, CiJobsResponse | undefined>(failedRuns.value.map((run, index) => [run.runId, queries.value[index]?.data]));
        // A green run failed nothing — known without asking, and it is what ends a streak.
        const entryOf = (run: PipelineRun): JobFailureRun => ({
            repo: run.repo,
            branch: run.branch,
            createdAt: run.createdAt,
            failed: run.status === `success` ? [] : failedOf(run, jobsByRun.get(run.runId)?.jobs),
        });
        return terminal.value.map(entryOf);
    });

    return {
        recurring: computed(() => recurringFailures(history.value)),
    };
}
