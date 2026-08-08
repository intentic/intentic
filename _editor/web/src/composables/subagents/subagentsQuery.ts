import { SubagentsListSchema, type SubagentSession } from "@intentic/sandbox-contract";
import { computed, type ComputedRef } from "vue";
import { sandboxJson } from "../sandbox/sandboxClient";
import { sandboxKey } from "../sandbox/useSandbox";
import { useSandboxQuery } from "../sandbox/useSandboxQuery";

/* THE ONE ROSTER of the agents this sandbox's agents started — shared by the rail tile and the Subagents area,
 * the same single-cache shape terminalsQuery and browsersQuery have, and for the same reason: the tile's count
 * and the area's list must not be able to disagree, which they would the moment each held its own copy.
 *
 * Like the browsers and unlike the terminals, there is no pending-claim half: a subagent exists because an
 * AGENT started it, so the daemon knows before this browser does and the list is the client's first knowledge of
 * it. There is nothing to paper over — and, for the same reason, nothing to poll: the registry pushes the
 * `subagents` domain as children are born, report and finish. It is the chattiest feed in the sandbox, so the
 * daemon rate-limits it to roughly the interval this used to poll on; what changes is that a quiet sandbox now
 * asks nothing at all, and a busy one repaints on the child's clock rather than on ours. */

const QUERY_KEY = sandboxKey(`subagents`);

const fetchSubagents = async (): Promise<SubagentSession[]> => SubagentsListSchema.parse(await sandboxJson(`/system/subagents`)).sessions;

// Live is `pending | running | paused` — the daemon's own split (see subagentRunning there). Duplicated as one
// exported predicate rather than re-derived per surface, so the rail's count and the area's grouping mean the
// same thing by construction.
const LIVE = new Set<SubagentSession["status"]>([`pending`, `running`, `paused`]);
export const subagentLive = (session: SubagentSession): boolean => LIVE.has(session.status);

export const useSubagentsQuery = (): {
    sessions: ComputedRef<SubagentSession[]>;
    running: ComputedRef<SubagentSession[]>;
    refetch: () => Promise<unknown>;
} => {
    const { query } = useSandboxQuery({ queryKey: QUERY_KEY, queryFn: fetchSubagents });
    // The daemon already sorts live-first then newest-active; the client keeps that order rather than imposing a
    // second one, so a row cannot move between the tile's count and the list under it.
    const sessions = computed(() => query.data.value ?? []);
    const running = computed(() => sessions.value.filter(subagentLive));
    return { sessions, running, refetch: () => query.refetch() };
};
