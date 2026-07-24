import { randomUUID } from "node:crypto";
import type { AgentReply } from "@intentic/sandbox-contract";

/* The bridge that lets an in-flight agent turn pause and wait for the user. Three cards park here — an
 * ExitPlanMode approval, a set of AskUserQuestion picks, and a per-tool permission prompt — and all three do
 * the same thing: mint an id, stream a frame carrying it, and block until `POST /agent/reply` resolves that
 * id. So there is one registry, not one per card: the reply's `kind` is what the waiter reads.
 *
 * A waiter always settles. If the turn aborts (Stop, or the browser dismissing a card) the abort signal
 * settles it with `onAbort`'s value instead, so the SDK's tool handler never hangs holding the turn open.
 *
 * The daemon is single-tenant (one container per project, reached only over its authenticated tunnel — the
 * owner's Google ID token), so requests are keyed by an unguessable id alone — no per-user scoping. */

type Waiter = (reply: AgentReply) => void;

const pending = new Map<string, Waiter>();

// Register a card awaiting the user. `onAbort` is the reply synthesized if the turn dies first — each caller
// supplies the answer that makes its own tool result read honestly ("cancelled", "denied", …).
export function createRequest<K extends AgentReply["kind"]>(
    kind: K,
    onAbort: Extract<AgentReply, { kind: K }>,
): { id: string; wait: (signal: AbortSignal) => Promise<Extract<AgentReply, { kind: K }>> } {
    const id = randomUUID();
    const wait = (signal: AbortSignal): Promise<Extract<AgentReply, { kind: K }>> =>
        new Promise((resolve) => {
            const settle = (reply: AgentReply): void => {
                if (!pending.delete(id)) {
                    return;
                }
                // A reply for the wrong card can only come from a client bug; the waiter's own kind is what
                // its caller is typed against, so an off-kind reply settles as the abort value instead.
                resolve(reply.kind === kind ? (reply as Extract<AgentReply, { kind: K }>) : onAbort);
            };
            if (signal.aborted) {
                settle(onAbort);
                return;
            }
            pending.set(id, settle);
            signal.addEventListener("abort", () => settle(onAbort), { once: true });
        });
    return { id, wait };
}

// Resolve the parked card. False when nothing holds that id — the turn already ended, and the route 404s.
export function resolveRequest(reply: AgentReply): boolean {
    const settle = pending.get(reply.requestId);
    if (settle === undefined) {
        return false;
    }
    settle(reply);
    return true;
}
