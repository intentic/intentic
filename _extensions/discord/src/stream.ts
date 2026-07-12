// Discord's per-message content limit; a longer reply spills into follow-up messages.
const DISCORD_MAX = 2_000;
// Min gap between edits of the growing message — Discord rate-limits edits (~5/5s per channel) and we don't need
// to repaint on every token. The typing indicator covers the gap until the first paint.
const EDIT_INTERVAL_MS = 1_200;

// A sink the daemon's ndjson turn-stream drives: delta(text) as the model types, end() when the turn finishes.
export interface Painter {
    readonly delta: (text: string) => void;
    readonly end: () => void;
}

// The slice of the discord.js channel API we use — structural so tests pass a fake and this file stays decoupled
// from discord.js. `channel.send(...)` returns a Message; `message.edit(...)` edits it in place.
export interface EditableMessage {
    readonly edit: (content: string) => Promise<unknown>;
}
export interface StreamChannel {
    readonly send: (content: string) => Promise<EditableMessage>;
}

// A painter that renders the model's text into Discord as it streams: the reply grows in one message, spilling
// into a new message every 2000 chars, repainted on a rate-limited timer and fully flushed on end(). Best-effort
// — a failed send/edit logs via onError and kills the stream, because a lost live update must never crash the
// turn. ponytail: hard 2000-char split (can cut mid-word) and no cap on message count; add a smarter boundary or
// a cap only if real replies need it.
export const createDiscordStream = (channel: StreamChannel, onError: (error: unknown) => void): Painter => {
    let buffer = "";
    let renderedLen = 0; // chars of `buffer` already reflected in Discord
    let base = 0; // char offset where the current (growing) message's content starts
    let current: EditableMessage | undefined; // the last message, still being edited; undefined ⇒ send a new one
    let timer: NodeJS.Timeout | undefined;
    let flushing = false;
    let dead = false;
    let ended = false;

    const emit = async (content: string): Promise<void> => {
        if (current === undefined) {
            current = await channel.send(content);
        } else {
            await current.edit(content);
        }
    };

    const reconcile = async (): Promise<void> => {
        if (flushing || dead || buffer.length === renderedLen) {
            return;
        }
        flushing = true;
        try {
            do {
                // Finalize every message that is now completely full (2000 chars) before painting the tail.
                while (buffer.length - base > DISCORD_MAX) {
                    await emit(buffer.slice(base, base + DISCORD_MAX));
                    current = undefined;
                    base += DISCORD_MAX;
                }
                await emit(buffer.slice(base) || "…");
                renderedLen = buffer.length;
                // One pass per timer tick while streaming (rate limit); once ended, loop until Discord has it all
                // even if deltas landed during the awaits above.
            } while (ended && renderedLen < buffer.length);
        } catch (error) {
            dead = true;
            onError(error);
        } finally {
            flushing = false;
            // A reconcile that raced end() (started before ended flipped) can leave a tail unrendered — finish it.
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
                }, EDIT_INTERVAL_MS);
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
