// Mid-turn steering: a running turn consumes its prompt as streaming input, so `/agent/steer` messages inject between
// tool calls, not abort-and-resend. The registry also holds each turn's hard-cancel: `/agent/stop` aborts daemon-side,
// since closing the fetch alone sends no cancel frame. Keyed by conversationId; no per-user scoping (daemon is
// single-tenant behind its tunnel).

// Unbounded push/pull text queue: the steer route pushes, the turn's input generator pulls; close() ends iteration and
// lets the turn settle.
export class SteeringQueue implements AsyncIterable<string> {
    private readonly buffer: string[] = [];
    private closed = false;
    private wake: (() => void) | undefined;

    // Messages accepted; streamSdk reads past a `result` while nonzero, since a steer can start a follow-up turn.
    delivered = 0;

    // False once closed, so the caller knows the message was not delivered.
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
    // Present only for turns supporting mid-turn injection; others register abort alone, and steering them reports
    // NOT_FOUND.
    readonly steering?: SteeringQueue;
}

const activeTurns = new Map<string, ActiveTurn>();

// Registers the conversation's in-flight turn; last-wins on a duplicate id (a stale entry, since the client serializes
// turns). Returns an unregister bound to this entry, so a stale one can't clobber a successor's registration.
export function registerTurn(conversationId: string, turn: ActiveTurn): () => void {
    activeTurns.set(conversationId, turn);
    return () => {
        if (activeTurns.get(conversationId) === turn) {
            activeTurns.delete(conversationId);
        }
    };
}

// Turns in flight right now; the idle-stop verdict reads it, since a machine mid-turn is never idle.
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
