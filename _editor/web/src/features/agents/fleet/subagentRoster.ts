import type { SubagentSession } from "@intentic/sandbox-contract";
import { computed, type ComputedRef } from "vue";
import { rpcQuery } from "../../../client/sandbox/rpcQuery";
import { useSandboxQuery } from "../../../client/sandbox/useSandboxQuery";

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
    // The ones a conversation's own runtime ran in-process, by the conversation whose turn started them. A spawned one
    // is a conversation too, and rides under its parent's card through the fleet (childFold) with everything a
    // conversation has, so it is left out here rather than counted twice.
    readonly inProcessOf: (conversationId: string) => readonly SubagentSession[];
}

export const useSubagentRoster = (): SubagentRoster => {
    // A refused read (a guest's) leaves the roster empty, which every reader takes as "none started".
    const { query } = useSandboxQuery(rpcQuery(`system.subagents`));
    const sessions = computed(() => query.data.value?.sessions ?? NONE);
    const byConversation = computed(() => {
        const grouped = new Map<string, SubagentSession[]>();
        for (const session of sessions.value) {
            if (session.kind !== `subagent`) {
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
    return { sessions, inProcessOf: (conversationId) => byConversation.value.get(conversationId) ?? NONE };
};
