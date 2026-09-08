import type { ListenerDispatchFrame } from "@intentic/sandbox-contract";

// A sink the daemon's ndjson turn-stream drives: delta(text) as the model types, end() when the turn finishes.
export interface Painter {
    readonly delta: (text: string) => void;
    readonly end: () => void;
}

// The slice of a provider's message API a streaming painter needs, structural so tests can fake it. `post` returns the
// handle `update` edits (Slack's ts, Telegram's message_id, discord.js's Message).
export interface StreamPoster<THandle> {
    readonly post: (text: string) => Promise<THandle>;
    readonly update: (handle: THandle, text: string) => Promise<unknown>;
}

// Where a message must spill into a follow-up, and how often the growing one may be repainted.
export interface StreamTuning {
    readonly maxChars: number;
    readonly editIntervalMs: number;
}

// Streams the model's reply into a channel: grows one message via edits, spills into a new one every maxChars,
// repainted on a rate-limited timer, flushed on end(). A failed post/update reports via onError and kills the stream.
export const createStreamingPainter = <THandle>(poster: StreamPoster<THandle>, onError: (error: unknown) => void, tuning: StreamTuning): Painter => {
    let buffer = "";
    let renderedLen = 0; // chars of `buffer` already reflected in the channel
    let base = 0; // char offset where the current (growing) message's text starts
    let current: THandle | undefined; // the last message, still being edited; undefined ⇒ post a new one
    let timer: NodeJS.Timeout | undefined;
    let flushing = false;
    let dead = false;
    let ended = false;

    const emit = async (text: string): Promise<void> => {
        if (current === undefined) {
            current = await poster.post(text);
            return;
        }
        await poster.update(current, text);
    };

    const reconcile = async (): Promise<void> => {
        if (flushing || dead || buffer.length === renderedLen) {
            return;
        }
        flushing = true;
        try {
            for (;;) {
                // Finalize every message that is now completely full before painting the tail.
                while (buffer.length - base > tuning.maxChars) {
                    await emit(buffer.slice(base, base + tuning.maxChars));
                    current = undefined;
                    base += tuning.maxChars;
                }
                await emit(buffer.slice(base) || "…");
                renderedLen = buffer.length;
                // One pass per tick while streaming; loop after end() until every delta lands, even ones during the
                // awaits.
                if (!ended || renderedLen >= buffer.length) {
                    break;
                }
            }
        } catch (error) {
            dead = true;
            onError(error);
        } finally {
            flushing = false;
            // A reconcile that raced end() (started before ended flipped) can leave a tail unrendered, finish it.
            if (ended && !dead && renderedLen < buffer.length) {
                void reconcile();
            }
        }
    };

    return {
        delta: (text) => {
            if (dead || ended || text === "") {
                return;
            }
            buffer += text;
            if (timer === undefined) {
                timer = setTimeout(() => {
                    timer = undefined;
                    void reconcile();
                }, tuning.editIntervalMs);
            }
        },
        end: () => {
            ended = true;
            if (timer !== undefined) {
                clearTimeout(timer);
                timer = undefined;
            }
            void reconcile();
        },
    };
};

// Buffers the whole reply and sends it once on end(), instead of streaming edits (WhatsApp flags rapid edits as
// automation). maxChars is a safety net, not pagination; a failed send kills the painter via onError.
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
                for (let base = 0; base < complete.length; base += maxChars) {
                    await send(complete.slice(base, base + maxChars));
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
