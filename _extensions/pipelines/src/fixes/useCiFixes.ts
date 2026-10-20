import type { AgentSummary } from "@intentic/sandbox-contract/schemas/agents";
import { CI_FIX_PREFIX } from "@intentic/sandbox-contract/ids/conversation-ids";
import { useQueryClient } from "@tanstack/vue-query";
import { computed, type Ref } from "vue";
import { host } from "../host";

// Fix agents already started, read off the fleet: no store needed since a fix conversation's id is derived from the run
// it fixes, so matching a row to its agent is a lookup by id, not a record that can drift. A failing main line names its one
// fixer outright (`fixer`), an id no later run derives, so the roster is handed on whole and every reader looks up only
// the ids it owns (fixesByRun, mainFailuresOf). Queries only when there is a failed run or a failing main line to ask about.

// The shell writes every roster frame from its event stream into this same `agents.list` entry (useAgents-registry.ts),
// so a fix starting, moving or ending shows the moment the daemon says so. The polls are the fallback for a frame missed
// across a reconnect (2026-10-20, the live pace was every 5 s as the only feed).
// Poll pace while a fix is moving.
const LIVE_POLL_MS = 15_000;
// Matches the board's CI poll; a fix can start elsewhere (another tab, phone), so this must still catch up.
const RESTING_POLL_MS = 30_000;

const moving = (agent: AgentSummary): boolean =>
    agent.status === `running` || agent.status === `resuming` || agent.status === `stopping` || agent.status === `dismissing`;

// The conversations this board sends: the fleet's other work moving must not quicken the pace.
const sentFromHere = (agent: AgentSummary): boolean => agent.id.startsWith(CI_FIX_PREFIX);

export function useCiFixes(enabled: Ref<boolean>) {
    const api = host();
    const queryClient = useQueryClient();
    const queryKey = computed(() => api.sandbox.readKey(`agents.list`));

    const { query } = api.sandbox.query({
        queryKey,
        enabled,
        // The fleet's own entry, the shell's roster read included, so a fix started here shows on the board at once.
        queryFn: () => api.sandbox.rpc.agents.list(),
        select: (answer): AgentSummary[] => answer.agents,
        // `awaiting` is not moving: a parked agent only changes when answered elsewhere, so the resting pace is enough.
        refetchInterval: (state) =>
            (state.state.data?.agents ?? []).some((agent) => sentFromHere(agent) && moving(agent)) ? LIVE_POLL_MS : RESTING_POLL_MS,
    });

    return {
        agents: computed<readonly AgentSummary[]>(() => query.data.value ?? []),
        // Called the moment a fix starts, so the row doesn't still offer to start what it just started.
        invalidate: (): Promise<void> => queryClient.invalidateQueries({ queryKey: queryKey.value }),
    };
}
