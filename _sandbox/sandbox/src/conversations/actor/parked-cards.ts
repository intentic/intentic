import { randomUUID } from "node:crypto";
import type { AgentEvent, AgentReply } from "@intentic/sandbox-contract";
import type { Caller } from "../../auth/auth.js";
import type { ConversationActors } from "./conversation-actors.js";
import type { Holding } from "./conversation-holdings.js";

// One registry for every parked card (plan, question, permission, a handover): mint an id, stream a frame carrying it,
// block until POST /agent/reply resolves it. A waiter always settles, an abort settles it with `onAbort` so the tool
// handler never hangs. Single-tenant daemon, so an unguessable id alone is the scoping.

type Waiter = (reply: AgentReply, fromUser: boolean, caller: Caller | undefined) => void;

// Undefined means anyone with a session may answer; a gated credential is the exception, addressed to a named list.
// Lives on the card, not the route, so a refusal leaves it parked rather than letting a stranger cancel it.
export type MayAnswer = (caller: Caller | undefined) => string | undefined;

interface Parked {
    readonly settle: Waiter;
    // Settles it with its abort stand-in, as if its turn had died.
    readonly abort: () => void;
    readonly mayAnswer: MayAnswer | undefined;
}

// Held by the conversation it was raised on, which a dismissal must be able to name, and aborted when a dispose takes
// it. One raised on none (the runtime's own plan and permission cards) waits in the conversationless bucket, which no
// dispose reaches: its waiter's own signal, the turn's, is what bounds it.
const PARKED: Holding<Parked> = { name: "parked cards", dropped: (parked) => parked.abort() };

export interface RequestOptions {
    readonly mayAnswer?: MayAnswer;
}

// Bundled together since only this module can tell a real answer from the abort stand-in; re-deriving that from a
// caller's own abort signal would race the settle it describes.
export interface Settled<K extends AgentReply["kind"]> {
    readonly reply: Extract<AgentReply, { kind: K }>;
    readonly resolved: Extract<AgentEvent, { kind: "resolved" }>;
    // Who answered, verified on the request; absent on an abort or a caller with no member identity.
    readonly caller?: Caller;
}

export interface ParkedCard<K extends AgentReply["kind"]> {
    readonly id: string;
    readonly wait: (signal: AbortSignal) => Promise<Settled<K>>;
}

export interface ParkedCards {
    // `onAbort` is the reply synthesized if the turn dies first, worded so each caller's own tool result reads honestly.
    // `conversationId` is what the card was raised on behalf of.
    readonly create: <K extends AgentReply["kind"]>(
        kind: K,
        onAbort: Extract<AgentReply, { kind: K }>,
        conversationId?: string,
        options?: RequestOptions,
    ) => ParkedCard<K>;
    // Re-registers a card under the id it was originally raised with (turn-resume.ts): a fresh id would strand the
    // replayed frame and any saved answer draft, both keyed by the old one.
    readonly restore: <K extends AgentReply["kind"]>(
        id: string,
        kind: K,
        onAbort: Extract<AgentReply, { kind: K }>,
        conversationId?: string,
        options?: RequestOptions,
    ) => ParkedCard<K>;
    // Three outcomes, not two: `missing` (no such card, the ordinary case for a remote turn, so the parent tries the
    // runner) and `refused` (a real card, wrong person, left parked) must stay distinct, or a stranger's click would read
    // as a stale one.
    readonly resolve: (reply: AgentReply, caller?: Caller) => "settled" | "missing" | { readonly refused: string };
    // Which conversation is parked on this card, for a settlement that acts on the turn rather than only answering it.
    // Read before resolving; the card is gone once it settles.
    readonly conversationOf: (requestId: string) => string | undefined;
}

/** How many cards the conversation's turn waits on an answer to; one answered leaves this count as its reply lands. */
export const cardsParkedOn = (conversations: Pick<ConversationActors, "holdings">, conversationId: string): number =>
    conversations.holdings(PARKED).of(conversationId).length;

// The cards parked in these actors' conversations, and in their conversationless bucket.
export const parkedCards = (conversations: Pick<ConversationActors, "holdings">): ParkedCards => {
    const restore = <K extends AgentReply["kind"]>(
        id: string,
        kind: K,
        onAbort: Extract<AgentReply, { kind: K }>,
        conversationId?: string,
        options?: RequestOptions,
    ): ParkedCard<K> => {
        const wait = (signal: AbortSignal): Promise<Settled<K>> =>
            new Promise((resolve) => {
                const parked = conversations.holdings(PARKED);
                let done = false;
                const settle = (reply: AgentReply, fromUser: boolean, caller: Caller | undefined): void => {
                    if (done) {
                        return;
                    }
                    done = true;
                    parked.drop(id);
                    // A reply for the wrong card can only be a client bug: the waiter's kind is what its caller is
                    // typed against.
                    const answered = fromUser && reply.kind === kind;
                    const settledReply = answered ? (reply as Extract<AgentReply, { kind: K }>) : onAbort;
                    // The abort stand-in wasn't chosen by anyone, so it carries no reply on the resolution frame.
                    resolve({
                        reply: settledReply,
                        resolved: { kind: "resolved", requestId: id, ...(answered ? { reply: settledReply } : {}) },
                        // Only a real answer carries a person; attributing the aborting request's identity would lie
                        // in an audit line.
                        ...(answered && caller !== undefined ? { caller } : {}),
                    });
                };
                const abort = (): void => settle(onAbort, false, undefined);
                parked.hold(conversationId, id, { settle, abort, mayAnswer: options?.mayAnswer });
                if (signal.aborted) {
                    abort();
                    return;
                }
                signal.addEventListener("abort", abort, { once: true });
            });
        return { id, wait };
    };
    return {
        create: (kind, onAbort, conversationId, options) => restore(randomUUID(), kind, onAbort, conversationId, options),
        restore,
        resolve: (reply, caller) => {
            const parked = conversations.holdings(PARKED).get(reply.requestId);
            if (parked === undefined) {
                return "missing";
            }
            // Consulted before settling, so a refusal costs the card nothing.
            const refused = parked.mayAnswer?.(caller);
            if (refused !== undefined) {
                return { refused };
            }
            parked.settle(reply, true, caller);
            return "settled";
        },
        conversationOf: (requestId) => conversations.holdings(PARKED).holder(requestId),
    };
};
