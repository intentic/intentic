import { type CiFixResponse, CiFixResponseSchema, type FixResume, type PipelineRun, runPickOf } from "@intentic/sandbox-contract";
import type { AgentRunChoice } from "@intentic/extension-ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/vue-query";
import { computed } from "vue";
import { ciRunsQuery } from "./ciRunsQuery";
import { host } from "./host";

// CI runs across the workspace's github/gitlab remotes, via the daemon's /ci routes (webhook-freshened, backfilled from
// vendors when stale). Runs are addressed by repo + vendor id; the daemon re-resolves the project and token per call.

const POLL_MS = 30_000;

const body = (run: PipelineRun): RequestInit => ({
    method: `POST`,
    headers: { "content-type": `application/json` },
    body: JSON.stringify({ repo: run.repo, runId: run.runId }),
});

export function usePipelines() {
    const api = host();
    const queryClient = useQueryClient();
    const spec = ciRunsQuery();
    const queryKey = spec.queryKey;
    const enabled = computed(() => api.sandbox.reachable());

    const query = useQuery({
        ...spec,
        enabled,
        refetchInterval: POLL_MS,
    });
    const invalidate = (): Promise<void> => queryClient.invalidateQueries({ queryKey });

    const rerun = useMutation({
        mutationFn: (run: PipelineRun) => api.sandbox.json(`/ci/runs/rerun`, body(run)),
        onSuccess: invalidate,
    });
    const cancel = useMutation({
        mutationFn: (run: PipelineRun) => api.sandbox.json(`/ci/runs/cancel`, body(run)),
        onSuccess: invalidate,
    });
    // Resolves to the fix conversation id (the fleet's card id) the view focuses. `pick` absent uses the run button's
    // own named default; effort travels with the model so a pick can't silently drop to the provider's default tier.
    // `mode` is the verb the picker's bar was ended with over an attempt that already exists; absent is the plain
    // press, which the daemon reads by the same rule the push card does (contract, planFixAttempt).
    const fix = useMutation({
        mutationFn: async ({
            run,
            pick,
            mode,
        }: {
            run: PipelineRun;
            pick?: AgentRunChoice | undefined;
            mode?: FixResume | undefined;
        }): Promise<CiFixResponse> =>
            CiFixResponseSchema.parse(
                await api.sandbox.json(`/ci/fix`, {
                    method: `POST`,
                    headers: { "content-type": `application/json` },
                    body: JSON.stringify({
                        repo: run.repo,
                        runId: run.runId,
                        ...(pick === undefined ? {} : { pick: runPickOf(pick) }),
                        ...(mode === undefined ? {} : { mode }),
                    }),
                }),
            ),
    });

    return {
        repos: computed(() => query.data.value?.repos ?? []),
        runs: computed(() => query.data.value?.runs ?? []),
        error: computed(() => query.error.value?.message),
        // isPending, not isLoading: true until the first response, including while `enabled` still gates the fetch.
        isPending: query.isPending,
        rerun,
        cancel,
        fix,
    };
}
