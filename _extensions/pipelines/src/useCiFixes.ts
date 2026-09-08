import { type AgentSummary, CI_FIX_PREFIX } from "@intentic/sandbox-contract";
import { useQuery, useQueryClient } from "@tanstack/vue-query";
import { computed, type Ref } from "vue";
import { host } from "./host";

// Fix agents already started, read off the fleet: no store needed since a fix conversation's id is derived from the run
// it fixes, so matching a row to its agent is a filter, not a record that can drift. Queries only when there is a
// failed run to ask about.

// Poll pace while a fix is moving; faster than the board's own CI poll since this can change in seconds.
const LIVE_POLL_MS = 5_000;
// Matches the board's CI poll; a fix can start elsewhere (another tab, phone), so this must still catch up.
const RESTING_POLL_MS = 30_000;

const moving = (agent: AgentSummary): boolean =>
    agent.status === `running` || agent.status === `resuming` || agent.status === `stopping` || agent.status === `dismissing`;

export function useCiFixes(enabled: Ref<boolean>) {
    const api = host();
    const queryClient = useQueryClient();
    const queryKey = computed(() => api.sandbox.key(`ci-fixes`));

    const query = useQuery({
        queryKey,
        enabled: computed(() => api.sandbox.reachable() && enabled.value),
        // Whole fleet comes back; filtered to this extension's conversations so nothing unrelated renders downstream.
        queryFn: async (): Promise<AgentSummary[]> =>
            (await api.sandbox.rpc.agents.list()).agents.filter((agent) => agent.id.startsWith(CI_FIX_PREFIX)),
        // `awaiting` is not moving: a parked agent only changes when answered elsewhere, so the resting pace is enough.
        refetchInterval: (state) => ((state.state.data ?? []).some(moving) ? LIVE_POLL_MS : RESTING_POLL_MS),
    });

    return {
        fixes: computed<readonly AgentSummary[]>(() => query.data.value ?? []),
        // Called the moment a fix starts, so the row doesn't still offer to start what it just started.
        invalidate: (): Promise<void> => queryClient.invalidateQueries({ queryKey: queryKey.value }),
    };
}
