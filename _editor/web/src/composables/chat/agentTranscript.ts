import type { RestoredMessage } from "@intentic/sandbox-contract";
import { queryClient, UNPERSISTED } from "../queryPersistence";
import { sandboxRequest } from "../sandbox/sandboxClient";
import { supportsRoute } from "../sandbox/useDaemonRoutes";
import { AGENTS } from "../queryKeys";

/* A REGISTERED AGENT'S TRANSCRIPT AS A CACHED READ, so the browser asks the daemon for it ONCE however many
 * surfaces want it.
 *
 * This used to be a bare fetch inside the chat's hydrate path, which made it a round trip charged to the click:
 * open an agent the daemon started, a workflow step, an automation's wake, a turn sent from a phone, and the
 * pane sat empty for the length of a tunnel hop before its first word appeared. It is a cached query now, which
 * changes nothing about that path except that the answer may already be there: the background loader warms the
 * board's cards, and a click then paints in the same tick.
 *
 * ONE ENTRY PER CONVERSATION, and concurrent callers share the one request (fetchQuery dedupes an in-flight
 * fetch per key), so a click that lands on a card the loader is CURRENTLY reading waits for that read instead
 * of opening a second one.
 *
 * UNPERSISTED, because a transcript is the app's other megabyte-scale record (see queryPersistence for what the
 * whole-cache mirror charges for one). Nothing is lost by keeping it out: a conversation the user has actually
 * opened is mirrored to disk per record by the Conversation itself, which is the store a reload paints from.
 *
 * staleTime Infinity for the same reason the file diffs use it: time is not what makes a transcript wrong, a
 * turn is, and a turn ending already invalidates this (useAgents' roster watch), so a warmed transcript can
 * never be older than the card that opens it. */

// The one distinction that matters to the caller: NOT_FOUND is the daemon saying this conversation has no
// registry entry any more (discarded, or a store that lost it), where a thrown request or any other status says
// only that we could not ask right now.
export type AgentTranscript = { readonly sessionId?: string; readonly messages: RestoredMessage[] } | "gone";

export const agentTranscriptKey = (conversationId: string): unknown[] => [...AGENTS.of(conversationId, `transcript`), UNPERSISTED];

// A turn is what makes a transcript wrong, see the header. Called wherever the daemon reports one settled.
export const invalidateAgentTranscript = (conversationId: string): void =>
    void queryClient.invalidateQueries({ queryKey: agentTranscriptKey(conversationId) });

const read = async (conversationId: string): Promise<AgentTranscript> => {
    const response = await sandboxRequest(`/agents/${encodeURIComponent(conversationId)}/transcript`);
    /* The 404 is only believed when the daemon ADVERTISES this route. A daemon older than this browser answers
     * 404 for a route it simply doesn't have (see useDaemonRoutes), and reading that as "your agent is gone"
     * would unregister every open agent tab in the app against a sandbox that is merely behind. */
    if (response.status === 404 && supportsRoute(`agents.transcript`)) {
        return `gone`;
    }
    if (!response.ok) {
        throw new Error(`Could not open that conversation.`);
    }
    const body = (await response.json()) as { sessionId?: string; messages?: RestoredMessage[] };
    return { ...(body.sessionId !== undefined ? { sessionId: body.sessionId } : {}), messages: body.messages ?? [] };
};

// Long enough that a board left open keeps every card it warmed; short enough that a session spent elsewhere
// gives the memory back. Collection makes the loader re-read it, which is a trickle rather than a cost.
const TRANSCRIPT_GC_MS = 30 * 60 * 1000;

/* The query, named apart from the call, because the background loader warms this same entry and must be handed
 * the QUERY rather than a function that fetches it. A wish that carries a key and a separate "how to read it" is
 * a wish whose two halves can disagree about where the answer lands, which is exactly how the loader once ended
 * up re-reading one thing forever (composables/prefetch/warmQuery). */
export const agentTranscriptQuery = (conversationId: string) => ({
    queryKey: agentTranscriptKey(conversationId),
    queryFn: () => read(conversationId),
    staleTime: Infinity,
    gcTime: TRANSCRIPT_GC_MS,
    // No retry, for the same reason the file diffs don't: a daemon hiccup during a read-ahead would turn one
    // quiet walk into four times the requests. A failure leaves nothing cached, so the click that follows
    // asks again for real and reports whatever went wrong where the user can act on it.
    retry: false as const,
});

export const agentTranscript = (conversationId: string): Promise<AgentTranscript> => queryClient.fetchQuery(agentTranscriptQuery(conversationId));
