import type { ListenerDispatchFrame } from "@intentic/sandbox-contract/protocol/doors/listener-protocol";
import { chunkMessage } from "./chunks.js";

// A sink the daemon's ndjson turn-stream drives: delta(text) as the model types, end() when the turn finishes.
export interface Painter {
    readonly delta: (text: string) => void;
    readonly end: () => void;
}

// Buffers the whole reply and sends it once on end(), for a chat that flags rapid edits as automation (WhatsApp); every
// chat with threads and edits answers through the shared chat reply (chat-reply.ts) instead. maxChars is a safety net, not pagination, cut where chunkMessage cuts; a failed send kills the painter
// via onError.
export const createBufferedPainter = (send: (text: string) => Promise<void>, onError: (error: unknown) => void, maxChars: number): Painter => {
    let buffer = "";
    let ended = false;

    return {
        delta: (text) => {
            if (ended) {
                return;
            }
            buffer += text;
        },
        end: () => {
            if (ended) {
                return;
            }
            ended = true;
            const complete = buffer;
            if (complete === "") {
                return;
            }
            void (async () => {
                for (const chunk of chunkMessage(complete, maxChars)) {
                    await send(chunk);
                }
            })().catch(onError);
        },
    };
};

// What a chat is told when a turn will not answer it: the daemon's own reason, unredacted, marked as the system
// speaking, and clamped to maxChars.
export const failureNotice = (reason: string, maxChars: number): string => `⚠️ ${reason}`.slice(0, maxChars);

// One painter per matched automation (keyed by automationId) so concurrent answers to one mention don't share a
// message. `failed` frames carry the refusal sentence and end nothing; surfaced to onFailed only.
export const framePainter = (makePainter: (automationId: string) => Painter, onFailed?: (reason: string) => void) => {
    const painters = new Map<string, Painter>();
    return (frame: ListenerDispatchFrame): void => {
        let painter = painters.get(frame.automationId);
        if (painter === undefined) {
            painter = makePainter(frame.automationId);
            painters.set(frame.automationId, painter);
        }
        if (frame.delta !== undefined) {
            painter.delta(frame.delta);
        }
        if (frame.failed !== undefined) {
            onFailed?.(frame.failed);
        }
        if (frame.end === true) {
            painter.end();
        }
    };
};
