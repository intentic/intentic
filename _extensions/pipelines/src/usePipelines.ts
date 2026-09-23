import { type CiFixResponse, type FixResume, isPipelineInFlight, type PipelineRun, runPickOf } from "@intentic/sandbox-contract";
import type { AgentRunChoice } from "@intentic/extension-ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/vue-query";
import { computed } from "vue";
import { ciRunsQuery } from "./ciRunsQuery";
import { host } from "./host";

// CI runs across the workspace's github/gitlab remotes, via the daemon's /ci routes (webhook-freshened, backfilled from
// vendors when stale). Runs are addressed by repo + vendor id; the daemon re-resolves the project and token per call.

const POLL_MS = 30_000;
// While anything is in flight somebody is watching it land, and a run that ended is pushed only where its repo's hook
// reaches the daemon (runtime-state's `ci`); this is the floor under a board whose hook is silent.
const POLL_IN_FLIGHT_MS = 10_000;

/** The board's beat: what is on it decides it, since a board with nothing moving has nothing to be late about. */
export const runsPollMs = (runs: readonly PipelineRun[] | undefined): number =>
    runs?.some((run) => isPipelineInFlight(run.status)) === true ? POLL_IN_FLIGHT_MS : POLL_MS;

export function usePipelines() {
    const api = host();
    const queryClient = useQueryClient();
    const spec = ciRunsQuery();
    const queryKey = spec.queryKey;
    const enabled = computed(() => api.sandbox.reachable());

    const query = useQuery({
        ...spec,
        enabled,
        refetchInterval: ({ state }) => runsPollMs(state.data?.runs),
    });
    const invalidate = (): Promise<void> => queryClient.invalidateQueries({ queryKey });

    const rerun = useMutation({
        mutationFn: (run: PipelineRun) => api.sandbox.rpc.ci.rerun({ repo: run.repo, runId: run.runId }),
        onSuccess: invalidate,
    });
    const cancel = useMutation({
        mutationFn: (run: PipelineRun) => api.sandbox.rpc.ci.cancel({ repo: run.repo, runId: run.runId }),
        onSuccess: invalidate,
    });
    // Resolves to the fix conversation id (the fleet's card id) the view focuses. `pick` absent uses the run button's
    // own named default; effort travels with the model so a pick can't silently drop to the provider's default tier.
    // `mode` is the verb the picker's bar was ended with over an attempt that already exists; absent is the plain
    // press, which the daemon reads by the same rule the push card does (contract, planFixAttempt).
    const fix = useMutation({
        mutationFn: ({ run, pick, mode }: { run: PipelineRun; pick?: AgentRunChoice | undefined; mode?: FixResume | undefined }): Promise<CiFixResponse> =>
            api.sandbox.rpc.ci.fix({
                repo: run.repo,
                runId: run.runId,
                ...(pick === undefined ? {} : { pick: runPickOf(pick) }),
                ...(mode === undefined ? {} : { mode }),
            }),
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
