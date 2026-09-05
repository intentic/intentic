import type { AgentHarness, AgentProvider, TranscriptRow, TurnEnding } from "@intentic/sandbox-contract";
import { queryClient, UNPERSISTED } from "../queryPersistence";
import { sandboxRequestVia } from "../sandbox/sandboxClient";
import { supportsRoute } from "../sandbox/useDaemonRoutes";
import { AGENTS } from "../queryKeys";
import { type PickUp, pickUpOf } from "./pickUp";
import type { SessionRef } from "./turnRequest";

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

/* The one distinction that matters to the caller: NOT_FOUND is the daemon saying this conversation has no
 * registry entry any more (discarded, or a store that lost it), where a thrown request or any other status says
 * only that we could not ask right now.
 *
 * `session` is the resumable session AND what it is bound to, folded into the one shape the chat decides with
 * (SessionRef). The wire sends the four flat, and reading them apart is what let a caller adopt an id while
 * filling its runtime and credential in from its own tab — the pair that decides whether the next message
 * resumes or opens a fresh session, answered by the side that cannot know. Present only when the daemon named
 * all of it.
 *
 * `ending` is the daemon's account of how the last turn ENDED, already folded into the pick-up state the chat
 * decides with, and the reason a tab that never watched it stop can still offer to pick it up
 * (Conversation.adoptEnding). */
/* `from` and `more` are the paging cursor: the daemon answers with the most recent turns, `from` says where
 * they start in the whole record, and handing that back as `before` asks for the page above. A conversation
 * shorter than one window arrives with `from: 0` and `more: false`, which is every conversation that has not
 * been running for days. */
export type AgentTranscript = { readonly session?: SessionRef; readonly ending?: PickUp; readonly messages: TranscriptRow[]; readonly from: number; readonly more: boolean } | "gone";

/* `at` is the box holding the conversation, undefined for the active one, and it belongs in the KEY as much as
 * in the request: two sandboxes can hold one conversation id (a workspace cloned onto a second machine, a
 * conversation resumed there), so identity here is (id, sandbox) like everywhere else that decides an action.
 * `ofSandbox` puts the id in the same last position `of` appends the active one to, which is what keeps these
 * entries inside the per-sandbox sweep rather than beside it. */
export const agentTranscriptKey = (conversationId: string, at?: string): unknown[] => [
    ...(at === undefined ? AGENTS.of(conversationId, `transcript`) : AGENTS.ofSandbox(at, conversationId, `transcript`)),
    UNPERSISTED,
];

// A turn is what makes a transcript wrong, see the header. Called wherever the daemon reports one settled.
export const invalidateAgentTranscript = (conversationId: string, at?: string): void =>
    void queryClient.invalidateQueries({ queryKey: agentTranscriptKey(conversationId, at) });

/* The id WITH the runtime that minted it, or nothing: a session that cannot say where it resumes cannot
 * answer the only question it is read for ("does my next message resume this?"), and half-answering it is
 * what the caller used to paper over with its own picks. A daemon that sends the id alone (one older than
 * this browser) is left to the tab's own recorded ref, which at least came from a turn that really ran.
 *
 * The account rides along and is allowed to be absent, because absent is a real answer: no stored account
 * served this conversation (the container's env token, a translator subscription). */
const boundSession = (body: { sessionId?: string; provider?: AgentProvider; harness?: AgentHarness; account?: string }): SessionRef | undefined =>
    body.sessionId !== undefined && body.provider !== undefined && body.harness !== undefined
        ? { id: body.sessionId, provider: body.provider, harness: body.harness, account: body.account }
        : undefined;

const read = async (conversationId: string, at: string | undefined, before?: number): Promise<AgentTranscript> => {
    const query = before === undefined ? `` : `?before=${before}`;
    const response = await sandboxRequestVia(at, `/agents/${encodeURIComponent(conversationId)}/transcript${query}`);
    /* The 404 is only believed when the daemon ADVERTISES this route. A daemon older than this browser answers
     * 404 for a route it simply doesn't have (see useDaemonRoutes), and reading that as "your agent is gone"
     * would unregister every open agent tab in the app against a sandbox that is merely behind. */
    if (response.status === 404 && supportsRoute(`agents.transcript`)) {
        return `gone`;
    }
    if (!response.ok) {
        throw new Error(`Could not open that conversation.`);
    }
    const body = (await response.json()) as {
        sessionId?: string;
        provider?: AgentProvider;
        harness?: AgentHarness;
        account?: string;
        ending?: TurnEnding;
        messages?: TranscriptRow[];
        from?: number;
        more?: boolean;
    };
    const bound = boundSession(body);
    /* A daemon older than this browser sends nothing here, which reads as "nothing to pick up" and is the right
     * way for this to be missing: the offer is an ADDITION to a chat that works without it, so a box that cannot
     * say leaves the tab exactly where it was before the field existed. */
    return {
        ...(bound !== undefined ? { session: bound } : {}),
        ...(body.ending !== undefined ? { ending: pickUpOf(body.ending) } : {}),
        messages: body.messages ?? [],
        /* A daemon that predates the window answered with the WHOLE record, which is exactly what "starts at
         * the beginning, nothing above it" describes — so the absent fields read correctly rather than needing
         * a branch: the chat draws it all and offers no page back, because there is none. */
        from: body.from ?? 0,
        more: body.more ?? false,
    };
};

// Long enough that a board left open keeps every card it warmed; short enough that a session spent elsewhere
// gives the memory back. Collection makes the loader re-read it, which is a trickle rather than a cost.
const TRANSCRIPT_GC_MS = 30 * 60 * 1000;

/* The query, named apart from the call, because the background loader warms this same entry and must be handed
 * the QUERY rather than a function that fetches it. A wish that carries a key and a separate "how to read it" is
 * a wish whose two halves can disagree about where the answer lands, which is exactly how the loader once ended
 * up re-reading one thing forever (composables/prefetch/warmQuery). */
export const agentTranscriptQuery = (conversationId: string, at?: string) => ({
    queryKey: agentTranscriptKey(conversationId, at),
    queryFn: () => read(conversationId, at),
    staleTime: Infinity,
    gcTime: TRANSCRIPT_GC_MS,
    // No retry, for the same reason the file diffs don't: a daemon hiccup during a read-ahead would turn one
    // quiet walk into four times the requests. A failure leaves nothing cached, so the click that follows
    // asks again for real and reports whatever went wrong where the user can act on it.
    retry: false as const,
});

export const agentTranscript = (conversationId: string, at?: string): Promise<AgentTranscript> =>
    queryClient.fetchQuery(agentTranscriptQuery(conversationId, at));

/* ONE PAGE FURTHER BACK, for a chat whose reader has scrolled to the top of what it holds. Deliberately NOT a
 * cached query: the entry above keys the conversation's OPENING page, which the warm loader fills and a
 * settled turn invalidates, and filing older pages under it would make the next open paint the middle of a
 * conversation. An older page is answered once, appended to the conversation that asked, and lives in that
 * conversation's state for as long as the tab holds it. */
export const olderTranscriptPage = (conversationId: string, before: number, at?: string): Promise<AgentTranscript> => read(conversationId, at, before);
