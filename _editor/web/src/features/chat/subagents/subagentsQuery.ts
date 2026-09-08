import { SubagentsListSchema, type SubagentSession } from "@intentic/sandbox-contract";
import { computed, type ComputedRef } from "vue";
import { sandboxJson } from "../../sandbox/client/sandboxClient";
import { SUBAGENTS } from "../../../lib/queryKeys";
import { useSandboxQuery } from "../../sandbox/client/useSandboxQuery";

// Shared roster of subagents this sandbox started; one cache for the rail tile and the Subagents area. No
// pending-claim half — the daemon knows before the client does and pushes the `subagents` domain instead of polling.

const QUERY_KEY = SUBAGENTS.of();

// Named to match the background prefetch loader that warms this entry for both the tile and the area.
export const subagentsKey = QUERY_KEY;
export const fetchSubagents = async (): Promise<SubagentSession[]> => SubagentsListSchema.parse(await sandboxJson(`/system/subagents`)).sessions;

// Matches the daemon's live-state split: pending, running, blocked, or paused.
const LIVE = new Set<SubagentSession["status"]>([`pending`, `running`, `blocked`, `paused`]);
export const subagentLive = (session: SubagentSession): boolean => LIVE.has(session.status);

export const useSubagentsQuery = (): {
    sessions: ComputedRef<SubagentSession[]>;
    running: ComputedRef<SubagentSession[]>;
    refetch: () => Promise<unknown>;
} => {
    const { query } = useSandboxQuery({ queryKey: QUERY_KEY, queryFn: fetchSubagents });
    // Keeps the daemon's live-first, newest-active order; do not re-sort.
    const sessions = computed(() => query.data.value ?? []);
    const running = computed(() => sessions.value.filter(subagentLive));
    return { sessions, running, refetch: () => query.refetch() };
};
