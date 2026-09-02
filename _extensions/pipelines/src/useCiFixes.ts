import { type AgentSummary, CI_FIX_PREFIX } from "@intentic/sandbox-contract";
import { useQuery, useQueryClient } from "@tanstack/vue-query";
import { computed, type Ref } from "vue";
import { host } from "./host";

/* THE FIX AGENTS THIS BOARD HAS ALREADY STARTED, read off the fleet.
 *
 * There is no store to keep and nothing to bookkeep: a fix conversation's id is derived from the run it fixes
 * (conversation-ids.ts), so joining a red row to its agent is a filter over the roster, not a record that can
 * drift. The same reasoning ext-maintenance's chore runs are built on, and the reason neither extension owns
 * any session machinery of its own.
 *
 * THROUGH THE TYPED CLIENT rather than a hand-built path: `agents.list()` carries the declared output shape, so
 * nothing here re-asserts or re-parses what the contract already promises. The manifest gates it identically,
 * the host resolves the procedure to `GET /agents` and checks THAT against `permissions.sandbox`.
 *
 * ASKED ONLY WHERE THERE IS SOMETHING TO ASK ABOUT. A board with no failed run has no fix to find, so the query
 * is off entirely: on a green workspace this feature costs one condition per poll and no requests at all. */

// While a turn is actually moving, matched to the pace of watching something work. Slower than the board's own
// CI poll on purpose: this answer changes in seconds, and the vendor's does not.
const LIVE_POLL_MS = 5_000;
/* And at rest, matched to the board's CI poll instead. Not `false` (the pace ext-maintenance rests at), because
 * unlike a chore run, nothing here is started only from this screen: the fix a user began on their phone, in
 * another tab, or the question it parked on ten minutes later, all arrive on this row and nowhere else. One
 * cheap daemon read a minute is what keeps the board from being a stale claim about work in flight. */
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
        // The whole fleet comes back; only this extension's conversations are kept, so nothing downstream can
        // accidentally read (or render) an agent that has nothing to do with a pipeline.
        queryFn: async (): Promise<AgentSummary[]> =>
            (await api.sandbox.rpc.agents.list()).agents.filter((agent) => agent.id.startsWith(CI_FIX_PREFIX)),
        // `awaiting` is deliberately not "moving": a parked agent changes when somebody answers it, which
        // happens in the chat rather than here, and the resting pace is soon enough for a board to catch up.
        refetchInterval: (state) => ((state.state.data ?? []).some(moving) ? LIVE_POLL_MS : RESTING_POLL_MS),
    });

    return {
        fixes: computed<readonly AgentSummary[]>(() => query.data.value ?? []),
        // For the moment a fix is STARTED: the roster gains a card the instant the daemon registers the turn, and
        // waiting out a poll to say so would leave the row offering to start what it just started.
        invalidate: (): Promise<void> => queryClient.invalidateQueries({ queryKey: queryKey.value }),
    };
}
