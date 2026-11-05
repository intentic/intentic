import type { ConversationActors } from "../actor/conversation-actors.js";
import { type AgentArchiveDeps, type AgentArchiveResult, archiveAgents } from "./archive.js";

// ARCHIVING A CARD THAT READS "STOPPING…" (2026-11-05). A stop is a request: the runtime is told and the turn ends when
// it answers, or when the grace runs out (agent/run/frames/stop-grace.ts) for one that never does (Devin's CLI ignores
// ACP's cancel), so the card sat at Stopping for up to fifteen seconds with no Archive anywhere, and the person who had
// just stopped it, to file it away, had to wait for the press to come back. An archive of a turn somebody already
// stopped is now accepted and waits the stop out here; the editor takes the card off the board on the press, so nothing
// is left on screen to wait for. Any other live turn is still refused by the route, since its checkout is being written
// to. The wait's bound is the route's (STOP_WAIT_MS), since the grace it is sized from is the agent layer's.

/** Whether the live turn is one a person already ended (a stop, a question waved away), still unwinding. */
const stopUnderway = (conversations: Pick<ConversationActors, "state">, id: string): boolean => {
    const phase = conversations.state(id)?.phase;
    return phase?.kind === "running" && phase.stopping !== undefined;
};

/** Resolves once the conversation has no turn running, or after `ms` whatever it is doing; never rejects. */
const untilTurnEnds = async (conversations: Pick<ConversationActors, "running" | "observe">, id: string, ms: number): Promise<void> => {
    if (!conversations.running(id)) {
        return;
    }
    const ended = Promise.withResolvers<void>();
    const unobserve = conversations.observe((conversationId, _event, _before, after) => {
        if (conversationId === id && after.phase.kind !== "running") {
            ended.resolve();
        }
    });
    const timer = setTimeout(ended.resolve, ms);
    try {
        await ended.promise;
    } finally {
        clearTimeout(timer);
        unobserve();
    }
};

/** Whether an archive press may name this conversation now: settled, or with a stop already unwinding. */
export const archivableNow = (conversations: Pick<ConversationActors, "running" | "state">, id: string): boolean =>
    !conversations.running(id) || stopUnderway(conversations, id);

/**
 * Archives `ids` once every stop under way among them has finished, waiting at most `waitMs` (the route's STOP_WAIT_MS).
 * One still unwinding past that, or begun meanwhile, keeps its checkout and comes back in `failed` with the reason, as a
 * release that failed does.
 */
export const archiveOnPress = async (
    deps: AgentArchiveDeps & { readonly conversations: Pick<ConversationActors, "observe"> },
    ids: readonly string[],
    now: () => number,
    waitMs: number,
): Promise<AgentArchiveResult> => {
    await Promise.all(ids.map((id) => untilTurnEnds(deps.conversations, id, waitMs)));
    const busy = new Set(ids.filter((id) => deps.conversations.running(id)));
    const result = await archiveAgents(
        deps,
        ids.filter((id) => !busy.has(id)),
        now(),
    );
    const refused = [...busy].map((id) => ({
        id,
        reason: stopUnderway(deps.conversations, id) ? "it is still stopping, archive it once it has stopped" : "a turn started in it meanwhile",
    }));
    return { archived: result.archived, failed: [...refused, ...result.failed] };
};
