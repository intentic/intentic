/* Mid-turn steering — the Claude Code queue-and-inject model. A running Claude turn consumes its prompt as a
 * streaming input (see agent.ts steeredInput), so user messages posted to /agent/steer while it works are
 * injected between tool calls instead of forcing an abort-and-resend. The registry below also carries each
 * turn's hard-cancel: /agent/stop aborts the turn daemon-side (closing the /agent fetch sends no cancel
 * frame, so the browser alone can't).
 *
 * Keyed by conversationId — the client-minted stable identity every chat turn already carries. The daemon is
 * single-tenant behind its authenticated tunnel, so no per-user scoping (same bet as agent-requests.ts). */

// An unbounded push/pull text queue: the steer route pushes, the turn's input generator pulls. close() ends
// iteration, which ends the SDK's streaming input and lets the turn settle.
export class SteeringQueue implements AsyncIterable<string> {
    private readonly buffer: string[] = [];
    private closed = false;
    private wake: (() => void) | undefined;

    // How many messages were accepted into the turn. The SDK stream emits a `result` per turn, and a
    // delivered steer may run as its own follow-up turn — streamSdk keeps consuming past a result while
    // this is non-zero (see its grace race) instead of ending the stream at the first one.
    delivered = 0;

    // False once closed — the caller then knows the message was NOT delivered.
    push(text: string): boolean {
        if (this.closed) {
            return false;
        }
        this.delivered += 1;
        this.buffer.push(text);
        this.wake?.();
        return true;
    }

    close(): void {
        this.closed = true;
        this.wake?.();
    }

    async *[Symbol.asyncIterator](): AsyncGenerator<string> {
        for (;;) {
            const next = this.buffer.shift();
            if (next !== undefined) {
                yield next;
                continue;
            }
            if (this.closed) {
                return;
            }
            await new Promise<void>((resolve) => {
                this.wake = resolve;
            });
            this.wake = undefined;
        }
    }
}

export interface ActiveTurn {
    // Hard-cancels the turn (aborts the SDK/provider adapter).
    readonly abort: () => void;
    // Present only on turns that support mid-turn injection (capabilitiesOf().steering — the Claude Code
    // harness, and Pi's steer queue); a native codex/grok/ACP turn registers abort alone, so steering it
    // reports NOT_FOUND and the client falls back to a fresh send.
    readonly steering?: SteeringQueue;
}

const activeTurns = new Map<string, ActiveTurn>();

// Register the conversation's in-flight turn; last-wins on a duplicate id (the client serializes turns, so a
// duplicate means a stale entry). Returns an unregister bound to THIS entry so the stale one can't clobber a
// successor's registration.
export function registerTurn(conversationId: string, turn: ActiveTurn): () => void {
    activeTurns.set(conversationId, turn);
    return () => {
        if (activeTurns.get(conversationId) === turn) {
            activeTurns.delete(conversationId);
        }
    };
}

// How many turns are in flight right now — the idle-stop verdict reads it (a machine mid-turn is not idle,
// however long the person who started the turn has been gone).
export const activeTurnCount = (): number => activeTurns.size;

// Deliver a steering message into the conversation's running turn; false when no steerable turn is live.
export function steerTurn(conversationId: string, text: string): boolean {
    return activeTurns.get(conversationId)?.steering?.push(text) ?? false;
}

// Hard-cancel the conversation's running turn; false when nothing is running.
export function stopTurn(conversationId: string): boolean {
    const turn = activeTurns.get(conversationId);
    if (turn === undefined) {
        return false;
    }
    turn.abort();
    return true;
}
