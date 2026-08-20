import { randomUUID } from "node:crypto";
import type { AgentEvent, AgentReply } from "@intentic/sandbox-contract";

/* The bridge that lets an in-flight agent turn pause and wait for the user. Three cards park here, an
 * ExitPlanMode approval, a set of AskUserQuestion picks, and a per-tool permission prompt, and all three do
 * the same thing: mint an id, stream a frame carrying it, and block until `POST /agent/reply` resolves that
 * id. So there is one registry, not one per card: the reply's `kind` is what the waiter reads.
 *
 * A waiter always settles. If the turn aborts (Stop, or the browser dismissing a card) the abort signal
 * settles it with `onAbort`'s value instead, so the SDK's tool handler never hangs holding the turn open.
 *
 * Every caller owes the stream a `resolved` frame the moment its waiter settles, that pair is the only honest
 * account of how long the turn was parked (see the frame's note in events.ts, and agents-registry.ts, which
 * lights the fleet's "needs you" lane from it). The frame is HANDED BACK by `wait` rather than left for each
 * caller to build: it carries how the card settled, and only this module can tell a user's answer from the
 * stand-in an abort settles with.
 *
 * The daemon is single-tenant (one container per project, reached only over its authenticated tunnel, the
 * owner's Google ID token), so requests are keyed by an unguessable id alone, no per-user scoping. */

type Waiter = (reply: AgentReply, fromUser: boolean) => void;

// A parked card: how to settle it, and, when its raiser knew, the conversation whose turn is parked on it.
// The conversation is carried because one settlement is not only an answer: dismissing a question ENDS the
// turn, and the route that takes the dismissal has to be able to name the turn it ends (see conversationOf).
interface Parked {
    readonly settle: Waiter;
    readonly conversationId: string | undefined;
}

const pending = new Map<string, Parked>();

// How a parked card settled: the reply its caller acts on, and the frame every client needs to see to stop
// rendering the card as live. They are handed out together because only this module can tell a user's answer
// from the stand-in an abort settles with, a caller re-deriving that from its own abort signal would race the
// settle it is trying to describe.
export interface Settled<K extends AgentReply["kind"]> {
    readonly reply: Extract<AgentReply, { kind: K }>;
    readonly resolved: Extract<AgentEvent, { kind: "resolved" }>;
}

// Register a card awaiting the user. `onAbort` is the reply synthesized if the turn dies first, each caller
// supplies the answer that makes its own tool result read honestly ("cancelled", "denied", …).
// `conversationId` is what the card was raised on behalf of, for the callers that run inside one.
export function createRequest<K extends AgentReply["kind"]>(
    kind: K,
    onAbort: Extract<AgentReply, { kind: K }>,
    conversationId?: string,
): { id: string; wait: (signal: AbortSignal) => Promise<Settled<K>> } {
    return restoreRequest(randomUUID(), kind, onAbort, conversationId);
}

/* Re-register a card under the id it was ORIGINALLY raised with, the restart path (turn-resume.ts). A parked
 * turn's cards survive a daemon death in the turn journal, and restoring them under fresh ids would strand
 * every copy the old id reached: the frame a reopened window replays, and the half-typed answer draft the
 * browser keys by requestId. The id space is shared and unguessable either way, a journalled id was minted by
 * createRequest one process ago. */
export function restoreRequest<K extends AgentReply["kind"]>(
    id: string,
    kind: K,
    onAbort: Extract<AgentReply, { kind: K }>,
    conversationId?: string,
): { id: string; wait: (signal: AbortSignal) => Promise<Settled<K>> } {
    const wait = (signal: AbortSignal): Promise<Settled<K>> =>
        new Promise((resolve) => {
            const settle = (reply: AgentReply, fromUser: boolean): void => {
                if (!pending.delete(id)) {
                    return;
                }
                // A reply for the wrong card can only come from a client bug; the waiter's own kind is what
                // its caller is typed against, so an off-kind reply settles as the abort value instead.
                const answered = fromUser && reply.kind === kind;
                const settledReply = answered ? (reply as Extract<AgentReply, { kind: K }>) : onAbort;
                // The abort stand-in is this module's own invention, not something a user chose, it must not
                // replay as an answer, so the resolution frame carries no reply and the card freezes cancelled.
                resolve({ reply: settledReply, resolved: { kind: "resolved", requestId: id, ...(answered ? { reply: settledReply } : {}) } });
            };
            // Registered BEFORE the aborted check, because the idempotence guard above is a delete: a settle
            // that runs before this id is in the map deletes nothing, reads that as "already settled", and
            // returns without resolving, leaving a card raised on an already-dead turn parked forever.
            pending.set(id, { settle, conversationId });
            if (signal.aborted) {
                settle(onAbort, false);
                return;
            }
            signal.addEventListener("abort", () => settle(onAbort, false), { once: true });
        });
    return { id, wait };
}

// Resolve the parked card. False when nothing holds that id, the turn already ended, and the route 404s.
export function resolveRequest(reply: AgentReply): boolean {
    const parked = pending.get(reply.requestId);
    if (parked === undefined) {
        return false;
    }
    parked.settle(reply, true);
    return true;
}

// Which conversation is parked on this card, for a settlement that does something to the TURN rather than only
// answering it. Read BEFORE resolving, the entry is gone the moment it settles.
export function conversationOf(requestId: string): string | undefined {
    return pending.get(requestId)?.conversationId;
}
