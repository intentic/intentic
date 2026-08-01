import { type CiFixResponse, CiFixResponseSchema, type CiRunsResponse, CiRunsResponseSchema, type PipelineRun } from "@intentic/sandbox-contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/vue-query";
import { computed } from "vue";
import { host } from "./host";

/* CI runs across the workspace repos' github/gitlab remotes, via the daemon's /ci routes. The daemon serves a
 * webhook-freshened cache and backfills it from the vendors when stale, so plain polling here costs one daemon
 * call — the vendors are only hit when the picture is actually stale. Actions address a run by repo + vendor
 * id; the daemon re-resolves the project and token per call. All daemon access goes through the host api. */

const POLL_MS = 30_000;

const body = (run: PipelineRun): RequestInit => ({
    method: `POST`,
    headers: { "content-type": `application/json` },
    body: JSON.stringify({ repo: run.repo, runId: run.runId }),
});

export function usePipelines() {
    const api = host();
    const queryClient = useQueryClient();
    const queryKey = api.sandbox.key(`ci-runs`);
    const enabled = computed(() => api.sandbox.reachable());

    const query = useQuery({
        queryKey,
        queryFn: async (): Promise<CiRunsResponse> => CiRunsResponseSchema.parse(await api.sandbox.json(`/ci/runs`)),
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
    // Starts an isolated agent seeded with the failure context; resolves to its conversation id, which is the
    // fleet's card id — the view hands it to /agents?focus= and the board lands on the card.
    const fix = useMutation({
        mutationFn: async (run: PipelineRun): Promise<CiFixResponse> => CiFixResponseSchema.parse(await api.sandbox.json(`/ci/fix`, body(run))),
    });

    return {
        repos: computed(() => query.data.value?.repos ?? []),
        runs: computed(() => query.data.value?.runs ?? []),
        error: computed(() => query.error.value?.message),
        // isPending, not isLoading: true from mount until the FIRST response, INCLUDING the window where
        // `enabled` still gates the fetch on the sandbox handshake. isLoading is false in that window (nothing
        // is in flight yet), which is how the view came to flash "no repo maps to a connected account" at
        // someone whose repos were about to load.
        isPending: query.isPending,
        rerun,
        cancel,
        fix,
    };
}
