import type { ListenerDispatchFrame } from "@intentic/sandbox-contract";

// A sink the daemon's ndjson turn-stream drives: delta(text) as the model types, end() when the turn finishes.
export interface Painter {
    readonly delta: (text: string) => void;
    readonly end: () => void;
}

// The slice of a provider's message API a streaming painter needs, structural so tests pass a fake and the
// painter stays decoupled from any SDK. `post` returns the handle `update` edits: Slack's string ts, Telegram's
// numeric message_id, discord.js's Message object.
export interface StreamPoster<THandle> {
    readonly post: (text: string) => Promise<THandle>;
    readonly update: (handle: THandle, text: string) => Promise<unknown>;
}

// The two per-channel facts the streaming machine varies on: where a message must spill into a follow-up, and
// how often the growing one may be repainted (every provider rate-limits edits differently).
export interface StreamTuning {
    readonly maxChars: number;
    readonly editIntervalMs: number;
}

/* A painter that renders the model's text into a channel as it streams: the reply grows in one message,
 * spilling into a new one every maxChars, repainted on a rate-limited timer and fully flushed on end().
 * Best-effort, a failed post/update reports via onError and kills the stream, because a lost live update must
 * never crash the turn.
 *
 * One machine for the discord/slack/telegram painters, which were deliberately identical: the daemon drives
 * all of them through the same TurnStream contract, and the only real differences were the character ceiling,
 * the edit cadence, and the type of the handle a posted message is edited by, now parameters.
 * ponytail: hard character split (can cut mid-word) and no cap on message count; add a smarter boundary or a
 * cap only if real replies need it. */
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
                // One pass per timer tick while streaming (rate limit); once ended, loop until the channel has
                // it all even if deltas landed during the awaits above (end() flips `ended` during those awaits).
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

/* A painter that deliberately does NOT stream. The streaming painters grow a message with edits as the model
 * types; on WhatsApp a message being rewritten twice a second is exactly the automation fingerprint that gets
 * numbers flagged, and every edit wears a visible "edited" label. So this painter buffers the whole reply and
 * sends it ONCE on end(), the typing indicator (listener-owned) is what tells the chat something is coming.
 * Same Painter interface, different rendering policy: the daemon drives both through the identical TurnStream
 * contract and never knows the difference. maxChars is a safety net, not a pagination scheme.
 *
 * Best-effort, a failed send reports via onError and kills the painter, because a lost reply must never crash
 * the turn. */
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

/* What a chat is told when a turn is not going to answer it. The daemon has always known this, a run already
 * going, a guard that said no, a wake that died on a revoked credential, and hands the reason to the sink; the
 * gateways used to drop it on the floor, so the channel got typing dots that stopped and nothing else, which
 * reads as the bot ignoring you rather than as anything having gone wrong.
 *
 * The reason goes out as the daemon wrote it: a gateway delivers into the owner's own space, so the real
 * sentence beats something neutral (the Front Desk, which faces strangers, redacts at its own sink instead).
 * Marked so it reads as the system speaking rather than as the agent, and clamped to the provider's ceiling. */
export const failureNotice = (reason: string, maxChars: number): string => `⚠️ ${reason}`.slice(0, maxChars);

/* The fan-out every mention-holding listener runs on a streaming dispatch: one painter per matched automation,
 * keyed by automationId, so two automations answering one mention don't scribble over each other's message.
 * Was copied verbatim into four listeners. `failed` frames carry the provider's own refusal sentence; they end
 * nothing (the turn's own end frame follows), so they're surfaced to onFailed and otherwise left alone. */
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
