import type { SubagentSession } from "@intentic/sandbox-contract";
import { computed, type ComputedRef } from "vue";
import { rpcQuery } from "../../sandbox/client/rpcQuery";
import { type ProcedureOutput, sandboxRpc } from "../../sandbox/client/sandboxRpc";
import { rpcKey } from "../../../lib/queryKeys";
import { useSandboxQuery } from "../../sandbox/client/useSandboxQuery";

// Shared roster of subagents this sandbox started; one cache for the rail tile and the Subagents area. No
// pending-claim half — the daemon knows before the client does and pushes the `subagents` domain instead of polling.

// Named to match the background prefetch loader that warms this entry for both the tile and the area. The whole
// answer, since a procedure's key holds what the procedure returns.
export const subagentsKey = rpcKey(`system.subagents`);
export const fetchSubagents = (): Promise<ProcedureOutput<`system.subagents`>> => sandboxRpc.system.subagents();

// Matches the daemon's live-state split: pending, running, blocked, or paused.
const LIVE = new Set<SubagentSession["status"]>([`pending`, `running`, `blocked`, `paused`]);
export const subagentLive = (session: SubagentSession): boolean => LIVE.has(session.status);

export const useSubagentsQuery = (): {
    sessions: ComputedRef<SubagentSession[]>;
    running: ComputedRef<SubagentSession[]>;
    refetch: () => Promise<unknown>;
} => {
    const { query } = useSandboxQuery(rpcQuery(`system.subagents`));
    // Keeps the daemon's live-first, newest-active order; do not re-sort.
    const sessions = computed(() => query.data.value?.sessions ?? []);
    const running = computed(() => sessions.value.filter(subagentLive));
    return { sessions, running, refetch: () => query.refetch() };
};
