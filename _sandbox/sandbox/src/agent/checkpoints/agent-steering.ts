import type { ConversationActors } from "../../agents/actor/conversation-actors.js";
import { turnRunOf } from "../../agents/actor/conversation-holdings.js";
import { markConversationTaint } from "../../guard/turn-taint.js";
import type { Steer } from "../../seams/turn-starter.js";

// Mid-turn steering: a running turn consumes its prompt as streaming input, so `/agent/steer` messages inject between
// tool calls, not abort-and-resend. Each live turn lends its conversation's actor its steering queue and its hard-cancel
// (`/agent/stop` aborts daemon-side, since closing the fetch alone sends no cancel frame).

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

// Lends the turn's one steering queue to whichever phase is running: a plan turn is two runs with an approval pause
// between them, and pulling from the queue directly would deliver a mid-pause message to the phase that already closed.
// Drained here once; what arrives during the pause waits for the next phase's channel.
export interface SteeringChannel {
    readonly steering: AsyncIterable<string>;
    readonly close: () => void;
}

export const steeringRelay = (queue: AsyncIterable<string>): (() => SteeringChannel) => {
    const waiting: string[] = [];
    let wake: (() => void) | undefined;
    let drained = false;
    void (async () => {
        for await (const text of queue) {
            waiting.push(text);
            wake?.();
        }
        drained = true;
        wake?.();
    })();
    return () => {
        let closed = false;
        return {
            steering: {
                async *[Symbol.asyncIterator](): AsyncGenerator<string> {
                    for (;;) {
                        // A message still waiting when the phase closes stays queued for the next phase, not this
                        // closing one.
                        if (closed) {
                            return;
                        }
                        const next = waiting.shift();
                        if (next !== undefined) {
                            yield next;
                            continue;
                        }
                        if (drained) {
                            return;
                        }
                        await new Promise<void>((resolve) => {
                            wake = resolve;
                        });
                        wake = undefined;
                    }
                },
            },
            close: () => {
                closed = true;
                wake?.();
            },
        };
    };
};

export interface ActiveTurn {
    // Hard-cancels the turn (aborts the SDK/provider adapter).
    readonly abort: () => void;
    // Present only for turns supporting mid-turn injection; others register abort alone, and steering them reports
    // NOT_FOUND.
    readonly steering?: SteeringQueue;
}

// False when no steerable turn is live. A person's steer marks the turn watched, since a turn that began unattended (a
// schedule, a chore, a CI failure) has somebody at the composer once they type; every other voice is framed here as
// the turn's own notice row, a person's by the route that took it.
export function steerTurn(
    conversations: Pick<ConversationActors, "steer" | "send" | "holdings">,
    conversationId: string,
    steer: Pick<Steer, "text" | "voice" | "outside">,
): boolean {
    if (!conversations.steer(conversationId, steer.text)) {
        return false;
    }
    if (steer.outside !== undefined) {
        markConversationTaint(conversationId, steer.outside);
    }
    if (steer.voice === "person") {
        conversations.send(conversationId, { kind: "person-steered" });
    } else {
        turnRunOf(conversations, conversationId)?.push({ kind: "steer", text: steer.text, sentAt: Date.now(), voice: steer.voice });
    }
    return true;
}
