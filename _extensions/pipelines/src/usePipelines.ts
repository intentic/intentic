import { type CiFixParam, type CiFixResponse, isPipelineInFlight, type PipelineRun } from "@intentic/sandbox-contract/schemas/ci";
import type { FixResume } from "@intentic/sandbox-contract/state/fix-attempt-plan";
import { runPickOf } from "@intentic/sandbox-contract/schemas/agent";
import type { AgentRunBooking, AgentRunChoice } from "@intentic/extension-ui";
import { useMutation, useQueryClient } from "@tanstack/vue-query";
import { computed } from "vue";
import { ciRunsQuery } from "./ciRunsQuery";
import { host } from "./host";

// CI runs across the workspace's github/gitlab remotes, via the daemon's /ci routes (webhook-freshened, backfilled from
// vendors when stale). Runs are addressed by repo + vendor id; the daemon re-resolves the project and token per call.

const POLL_MS = 60_000;
// In-flight runs push on every webhook phase (`runtime-state`'s `ci`); this interval is only the fallback when hooks are
// silent or the editor missed a frame (2026-10-20).
const POLL_IN_FLIGHT_MS = 45_000;

/** The board's beat: what is on it decides it, since a board with nothing moving has nothing to be late about. */
export const runsPollMs = (runs: readonly PipelineRun[] | undefined): number =>
    runs?.some((run) => isPipelineInFlight(run.status)) === true ? POLL_IN_FLIGHT_MS : POLL_MS;

// What a press asks of the daemon. The caret's `pick` is a choice and outranks everything; a plain press sends what the
// button names instead (`standing`: the job's pin, or the model a new chat would open on) as the fallback, which the
// daemon runs only when no model pinned for the job can: it holds no chat pick of its own, and once opened an
// unpinned fix on a provider the owner never connected.
// `booking` is the button's (useAgentRunPick): the model's allowance is spent, so the fix is booked for its reopen. A booked
// press names its model outright, since the booking waits for that model's allowance: the run that starts then is the one
// the button named, never a rung of the job's list the sandbox would reach by itself in the meantime.
export const fixParams = ({
    run,
    pick,
    mode,
    standing,
    booking,
}: {
    readonly run: PipelineRun;
    readonly pick?: AgentRunChoice | undefined;
    readonly mode?: FixResume | undefined;
    readonly standing: AgentRunChoice;
    readonly booking?: AgentRunBooking | undefined;
}): CiFixParam => {
    const named = pick ?? (booking !== undefined && standing.model !== `` ? standing : undefined);
    const params: CiFixParam = {
        repo: run.repo,
        runId: run.runId,
        // No fallback while the chat default names no model yet (a provider whose catalog has not loaded): sent empty, the
        // sandbox refuses the whole press as bad input, where without one it opens on its own default.
        ...(named === undefined ? (standing.model === `` ? {} : { fallback: runPickOf(standing) }) : { pick: runPickOf(named) }),
        ...(mode === undefined ? {} : { mode }),
    };
    if (booking !== undefined) {
        params.sendAt = booking.sendAt;
        params.sendAtReopen = booking.sendAtReopen;
    }
    return params;
};

/** One press of a Fix button: the run, the caret's pick, the verb its panel ended with, and the booking it showed. */
export interface FixPress {
    readonly run: PipelineRun;
    readonly pick?: AgentRunChoice | undefined;
    readonly mode?: FixResume | undefined;
    readonly booking?: AgentRunBooking | undefined;
}

export function usePipelines() {
    const api = host();
    const queryClient = useQueryClient();
    const spec = ciRunsQuery();
    const queryKey = spec.queryKey;

    const { query, loaded } = api.sandbox.query({
        ...spec,
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
    // press, which the daemon reads by the contract's own rule (planFixAttempt).
    // `booking` holds it for a spent allowance's reopen, as the button that was pressed said it would.
    const fix = useMutation({
        mutationFn: ({ run, pick, mode, booking }: FixPress): Promise<CiFixResponse> =>
            api.sandbox.rpc.ci.fix(fixParams({ run, pick, mode, booking, standing: api.models.agentRun(`pipeline-fix`) })),
    });

    return {
        repos: computed(() => query.data.value?.repos ?? []),
        runs: computed(() => query.data.value?.runs ?? []),
        // Main-line branches failing right now, each with the one fix agent the daemon put on it; absent from a daemon
        // that keeps none, which reads the same as none failing.
        failures: computed(() => query.data.value?.failures ?? []),
        // Waiting until the first response, including while the sandbox is not answering yet; never an empty board.
        loaded,
        rerun,
        cancel,
        fix,
    };
}
