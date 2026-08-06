// Telegram refuses a sendMessage over 4096 characters outright (400, nothing posted), so a longer reply spills
// into follow-up messages in the same chat. Below the ceiling to leave room for the "…" placeholder.
const TELEGRAM_MAX = 3_900;
// Min gap between edits of the growing message. Telegram's per-chat budget is about one message a second (20 a
// minute in groups) and edits spend it too, so this is slower than Slack's — the typing indicator covers the
// gap until the first paint.
const EDIT_INTERVAL_MS = 2_500;

// A sink the daemon's ndjson turn-stream drives: delta(text) as the model types, end() when the turn finishes.
export interface Painter {
    readonly delta: (text: string) => void;
    readonly end: () => void;
}

// The slice of the Bot API this file uses — structural so tests pass a fake. `post` returns the new message's
// message_id, which is the handle `update` edits.
export interface TelegramPoster {
    readonly post: (text: string) => Promise<number>;
    readonly update: (messageId: number, text: string) => Promise<void>;
}

/* A painter that renders the model's text into a Telegram chat as it streams: the reply grows in one message,
 * spilling into a new one every TELEGRAM_MAX chars, repainted on a rate-limited timer and fully flushed on
 * end(). Best-effort — a failed post/update logs via onError and kills the stream, because a lost live update
 * must never crash the turn.
 *
 * Structurally the same machine as ext-slack's and ext-discord's painters, and deliberately so: the daemon
 * drives all three through the identical TurnStream contract, and the only real differences are the character
 * ceiling, the edit cadence, and that Telegram addresses an existing message by a numeric message_id.
 * ponytail: hard character split (can cut mid-word) and no cap on message count; add a smarter boundary or a
 * cap only if real replies need it. */
export const createTelegramStream = (poster: TelegramPoster, onError: (error: unknown) => void): Painter => {
    let buffer = "";
    let renderedLen = 0; // chars of `buffer` already reflected in Telegram
    let base = 0; // char offset where the current (growing) message's text starts
    let currentId: number | undefined; // the last message, still being edited; undefined ⇒ post a new one
    let timer: NodeJS.Timeout | undefined;
    let flushing = false;
    let dead = false;
    let ended = false;

    const emit = async (text: string): Promise<void> => {
        if (currentId === undefined) {
            currentId = await poster.post(text);
            return;
        }
        await poster.update(currentId, text);
    };

    const reconcile = async (): Promise<void> => {
        if (flushing || dead || buffer.length === renderedLen) {
            return;
        }
        flushing = true;
        try {
            for (;;) {
                // Finalize every message that is now completely full before painting the tail.
                while (buffer.length - base > TELEGRAM_MAX) {
                    await emit(buffer.slice(base, base + TELEGRAM_MAX));
                    currentId = undefined;
                    base += TELEGRAM_MAX;
                }
                await emit(buffer.slice(base) || "…");
                renderedLen = buffer.length;
                // One pass per timer tick while streaming (rate limit); once ended, loop until Telegram has it
                // all even if deltas landed during the awaits above (end() flips `ended` during those awaits).
                if (!ended || renderedLen >= buffer.length) {
                    break;
                }
            }
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
