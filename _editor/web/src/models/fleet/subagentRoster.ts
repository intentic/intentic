import type { SubagentSession } from "@intentic/sandbox-contract/schemas/terminal";
import { computed, type ComputedRef } from "vue";
import { rpcQuery } from "../../client/sandbox/rpcQuery";
import { useSandboxQuery } from "../../client/sandbox/useSandboxQuery";
import { startingIds } from "./launches/startingChildren";
import { registry } from "./useAgents-registry";

// The sandbox's roster of every subagent its conversations started, in-process and spawned alike: one cache for the
// board, whose cards carry them in their trays (childFold), and for the chat's delegation cards, which read how one is
// doing after the turn that started it stopped streaming. Pushed, not polled: the daemon names the `subagents` domain
// the moment a record moves.

// Matches the daemon's live-state split: pending, running, blocked, or paused.
const LIVE = new Set<SubagentSession["status"]>([`pending`, `running`, `blocked`, `paused`]);
export const subagentLive = (session: Pick<SubagentSession, "status">): boolean => LIVE.has(session.status);

const NONE: readonly SubagentSession[] = [];

export interface SubagentRoster {
    // Live first, then most recently active, as the daemon orders them; do not re-sort.
    readonly sessions: ComputedRef<readonly SubagentSession[]>;
    // The rows a conversation's card carries in its tray from the roster, by the conversation whose turn started them:
    // what its own runtime ran in-process and the tasks it handed to a linked sandbox, neither of them a conversation here,
    // and the children it spawned that are not one YET. A spawned child rides under its parent's card through the fleet
    // (childFold) once its first turn has begun, with everything a conversation has, so from then on it is left out here
    // rather than counted twice. Before that the roster's row is all there is of it: a start held for the owner's answer,
    // behind its lane's first child (fan-out-governor.ts), for a seat or for memory, which took minutes and left the
    // board showing nothing of four children the owner had just allowed (2026-11-06).
    readonly rowsOf: (conversationId: string) => readonly SubagentSession[];
}

export const useSubagentRoster = (): SubagentRoster => {
    // A refused read (a guest's) leaves the roster empty, which every reader takes as "none started".
    const { query } = useSandboxQuery(rpcQuery(`system.subagents`));
    const sessions = computed(() => query.data.value?.sessions ?? NONE);
    const liveSpawned = computed(() => sessions.value.filter((session) => session.kind === `spawned` && subagentLive(session)));
    const starting = computed<ReadonlySet<string>>((previous) => startingIds(liveSpawned.value, () => registry.value, previous));
    const byConversation = computed(() => {
        const grouped = new Map<string, SubagentSession[]>();
        for (const session of sessions.value) {
            // A spawned child the fleet holds rides as its conversation; a linked task is no conversation here either,
            // and its tray row is how its parent's card shows it.
            if (session.kind === `spawned` && !starting.value.has(session.id)) {
                continue;
            }
            const own = grouped.get(session.conversationId);
            if (own === undefined) {
                grouped.set(session.conversationId, [session]);
            } else {
                own.push(session);
            }
        }
        return grouped;
    });
    return { sessions, rowsOf: (conversationId) => byConversation.value.get(conversationId) ?? NONE };
};
