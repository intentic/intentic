import type { AgentHarness, AgentProvider, TranscriptRow, TranscriptTool } from "@intentic/sandbox-contract";
import { queryClient, UNPERSISTED } from "../../../lib/queryPersistence";
import { orRefusal, SandboxHttpError } from "../../sandbox/client/sandboxHttpError";
import { sandboxRpc } from "../../sandbox/client/sandboxRpc";
import { supportsRoute } from "../../sandbox/overview/useDaemonRoutes";
import { AGENTS } from "../../../lib/queryKeys";
import { type PickUp, pickUpOf } from "../run/pickUp";
import type { SessionRef } from "../run/turnRequest";

// A registered agent's transcript as a cached query, so concurrent callers share one fetch instead of each re-asking
// the daemon. Unpersisted, since a transcript is megabyte-scale and the Conversation itself already mirrors an opened
// chat to disk. staleTime Infinity: a turn ending invalidates this, so a warmed transcript is never stale.

// "gone" means the daemon has no registry entry for this conversation, unlike a thrown request. `session` is present
// only when the daemon named id, provider, harness and account together.
// `ending` is the daemon's account of how the last turn ended. `from`/`more` are the paging cursor: `from` is the
// record offset the page starts at; handing it back as `before` asks for the page above.
export type AgentTranscript = { readonly session?: SessionRef; readonly ending?: PickUp; readonly messages: TranscriptRow[]; readonly from: number; readonly more: boolean } | "gone";

// `at` (the box holding the conversation) belongs in the key: two sandboxes can hold the same conversation id.
// `ofSandbox` positions the id like `of` does, keeping entries inside the same per-sandbox sweep.
export const agentTranscriptKey = (conversationId: string, at?: string): unknown[] => [
    ...(at === undefined ? AGENTS.of(conversationId, `transcript`) : AGENTS.ofSandbox(at, conversationId, `transcript`)),
    UNPERSISTED,
];

// Called wherever the daemon reports a turn settled, which is what invalidates a transcript.
export const invalidateAgentTranscript = (conversationId: string, at?: string): void =>
    void queryClient.invalidateQueries({ queryKey: agentTranscriptKey(conversationId, at) });

// A session resumes only on the runtime that minted it, so an id without its provider and harness is none; `account` may be absent.
const boundSession = (body: { sessionId?: string; provider?: AgentProvider; harness?: AgentHarness; account?: string }): SessionRef | undefined =>
    body.sessionId !== undefined && body.provider !== undefined && body.harness !== undefined
        ? { id: body.sessionId, provider: body.provider, harness: body.harness, account: body.account }
        : undefined;

const read = async (conversationId: string, at: string | undefined, before?: number): Promise<AgentTranscript> => {
    const page = await orRefusal(sandboxRpc.agents.transcript({ id: conversationId, before }, { context: { at } }));
    if (page instanceof SandboxHttpError) {
        // 404 is trusted only when the daemon advertises this route; an older one's 404 just means no such route.
        if (page.status === 404 && supportsRoute(`agents.transcript`)) {
            return `gone`;
        }
        throw new Error(`Could not open that conversation.`);
    }
    const bound = boundSession(page);
    return {
        ...(bound !== undefined ? { session: bound } : {}),
        ...(page.ending !== undefined ? { ending: pickUpOf(page.ending) } : {}),
        messages: page.messages,
        from: page.from,
        more: page.more,
    };
};

// Long enough to keep a left-open board's warmed cards; short enough to free memory when unviewed.
const TRANSCRIPT_GC_MS = 30 * 60 * 1000;

// Exposed as a query object, not a fetch function, since the background loader must warm this exact cache entry rather
// than one with a matching key but a separate reader.
export const agentTranscriptQuery = (conversationId: string, at?: string) => ({
    queryKey: agentTranscriptKey(conversationId, at),
    queryFn: () => read(conversationId, at),
    staleTime: Infinity,
    gcTime: TRANSCRIPT_GC_MS,
    // No retry, so a read-ahead hiccup doesn't multiply requests; a failed read simply retries on the next click.
    retry: false as const,
});

export const agentTranscript = (conversationId: string, at?: string): Promise<AgentTranscript> =>
    queryClient.fetchQuery(agentTranscriptQuery(conversationId, at));

// Not a cached query, deliberately: this key holds the conversation's opening page, and filing older pages there would
// paint the middle of a chat on next open. Appended to that conversation's own state instead.
export const olderTranscriptPage = (conversationId: string, before: number, at?: string): Promise<AgentTranscript> => read(conversationId, at, before);

// A delegation's own calls, which the page counts (`nested`) rather than carries. Fetched on the press that opens the
// card, so reopening a conversation full of delegations costs the cards, not their runs. A failed read is empty, not an
// error: the card simply stays as it was and the next press asks again.
export const agentToolChildren = async (conversationId: string, toolId: string, at?: string): Promise<TranscriptTool[]> => {
    const delegation = await orRefusal(sandboxRpc.agents.toolChildren({ id: conversationId, toolId }, { context: { at } }));
    return delegation instanceof SandboxHttpError ? [] : delegation.children;
};
