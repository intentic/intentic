import { randomUUID } from "node:crypto";
import type { AgentEvent, AgentReply } from "@intentic/sandbox-contract";
import type { Caller } from "../../auth/auth.js";

// One registry for every parked card (plan, question, permission): mint an id, stream a frame carrying it, block until
// POST /agent/reply resolves it. A waiter always settles, an abort settles it with `onAbort` so the tool handler never
// hangs. Single-tenant daemon, so an unguessable id alone is the scoping.

type Waiter = (reply: AgentReply, fromUser: boolean, caller: Caller | undefined) => void;

// Undefined means anyone with a session may answer; a gated credential is the exception, addressed to a named list.
// Lives on the card, not the route, so a refusal leaves it parked rather than letting a stranger cancel it.
export type MayAnswer = (caller: Caller | undefined) => string | undefined;

// conversationId is carried since a dismissal ends the turn outright, and the route taking it must be able to name what
// it ends.
interface Parked {
    readonly settle: Waiter;
    readonly conversationId: string | undefined;
    readonly mayAnswer: MayAnswer | undefined;
}

export interface RequestOptions {
    readonly mayAnswer?: MayAnswer;
}

const pending = new Map<string, Parked>();

// Bundled together since only this module can tell a real answer from the abort stand-in; re-deriving that from a
// caller's own abort signal would race the settle it describes.
export interface Settled<K extends AgentReply["kind"]> {
    readonly reply: Extract<AgentReply, { kind: K }>;
    readonly resolved: Extract<AgentEvent, { kind: "resolved" }>;
    // Who answered, verified on the request; absent on an abort or a caller with no member identity.
    readonly caller?: Caller;
}

// `onAbort` is the reply synthesized if the turn dies first, worded so each caller's own tool result reads honestly.
// `conversationId` is what the card was raised on behalf of.
export function createRequest<K extends AgentReply["kind"]>(
    kind: K,
    onAbort: Extract<AgentReply, { kind: K }>,
    conversationId?: string,
    options?: RequestOptions,
): { id: string; wait: (signal: AbortSignal) => Promise<Settled<K>> } {
    return restoreRequest(randomUUID(), kind, onAbort, conversationId, options);
}

// Re-registers a card under the id it was originally raised with (turn-resume.ts): a fresh id would strand the replayed
// frame and any saved answer draft, both keyed by the old one.
export function restoreRequest<K extends AgentReply["kind"]>(
    id: string,
    kind: K,
    onAbort: Extract<AgentReply, { kind: K }>,
    conversationId?: string,
    options?: RequestOptions,
): { id: string; wait: (signal: AbortSignal) => Promise<Settled<K>> } {
    const wait = (signal: AbortSignal): Promise<Settled<K>> =>
        new Promise((resolve) => {
            const settle = (reply: AgentReply, fromUser: boolean, caller: Caller | undefined): void => {
                if (!pending.delete(id)) {
                    return;
                }
                // A reply for the wrong card can only be a client bug: the waiter's kind is what its caller is typed
                // against.
                const answered = fromUser && reply.kind === kind;
                const settledReply = answered ? (reply as Extract<AgentReply, { kind: K }>) : onAbort;
                // The abort stand-in wasn't chosen by anyone, so it carries no reply on the resolution frame.
                resolve({
                    reply: settledReply,
                    resolved: { kind: "resolved", requestId: id, ...(answered ? { reply: settledReply } : {}) },
                    // Only a real answer carries a person; attributing the aborting request's identity would lie in an
                    // audit line.
                    ...(answered && caller !== undefined ? { caller } : {}),
                });
            };
            // Registered first, or the delete-based idempotence guard would read an early settle as already resolved.
            pending.set(id, { settle, conversationId, mayAnswer: options?.mayAnswer });
            if (signal.aborted) {
                settle(onAbort, false, undefined);
                return;
            }
            signal.addEventListener("abort", () => settle(onAbort, false, undefined), { once: true });
        });
    return { id, wait };
}

// Three outcomes, not two: `missing` (no such card, the ordinary case for a remote turn, so the parent tries the
// runner) and `refused` (a real card, wrong person, left parked) must stay distinct, or a stranger's click would read
// as a stale one.
export function resolveRequest(reply: AgentReply, caller?: Caller): "settled" | "missing" | { refused: string } {
    const parked = pending.get(reply.requestId);
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
}

// Which conversation is parked on this card, for a settlement that acts on the turn rather than only answering it. Read
// before resolving; the entry is gone once it settles.
export function conversationOf(requestId: string): string | undefined {
    return pending.get(requestId)?.conversationId;
}
