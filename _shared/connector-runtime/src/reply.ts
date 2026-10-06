import type { ListenerMessage } from "@intentic/sandbox-contract";
import type { DaemonClient } from "./daemon.js";
import { createBufferedPainter, createStreamingPainter, failureNotice, framePainter, type StreamPoster } from "./painter.js";

// What every chat gateway does the same way once it has decided a message is for us: deliver a message outside a turn
// in chunks, and paint a turn's reply back into the chat. Each platform still decides what "for us" means.

// Recent delivery keys a listener remembers to drop a redelivered or shared-room duplicate; a restart forgets them,
// at worst one duplicate wake.
export const RECENT_KEYS_MAX = 500;
// Prior messages handed to the model with a mention (Discord's own fetch caps at 100).
export const HISTORY_LIMIT = 20;
// How long a "typing…" indicator may be held for one turn, so a stalled turn can't leak it forever.
export const TYPING_MAX_MS = 300_000;

// Posts `text` through the first target that takes it, `max` characters per message. A target that fails before its
// first chunk lands is passed over for the next; once a chunk landed, a failure is thrown instead, so a partial spill
// is never posted twice. Returns what each chunk's send returned, in order. With no target, throws `none()`; when every
// target failed, the last failure.
export const deliverChunked = async <TTarget, TSent>(
    targets: Iterable<TTarget>,
    send: (target: TTarget, chunk: string) => Promise<TSent>,
    text: string,
    max: number,
    none: () => Error,
): Promise<TSent[]> => {
    let failure: unknown;
    let tried = false;
    for (const target of targets) {
        tried = true;
        const sent: TSent[] = [];
        try {
            for (let base = 0; base < text.length; base += max) {
                sent.push(await send(target, text.slice(base, base + max)));
            }
            return sent;
        } catch (error) {
            if (sent.length > 0) {
                throw error;
            }
            failure = error;
        }
    }
    throw tried ? failure : none();
};

// Where a reply goes: grown by edits through a poster (Discord, Slack, Telegram), or sent whole once the turn ends
// (WhatsApp, which flags rapid edits as automation).
export type ReplySurface<THandle> =
    | { readonly stream: StreamPoster<THandle>; readonly editIntervalMs: number }
    | { readonly send: (text: string) => Promise<void> };

export interface ReplyOptions<THandle> {
    readonly surface: ReplySurface<THandle>;
    // The platform's one-message ceiling; a longer reply spills into a follow-up.
    readonly maxChars: number;
    // A failed post or edit; it ends that painter, never the dispatch.
    readonly onError: (error: unknown) => void;
    // Runs once the turn(s) ended or the stream broke: retire the typing indicator or acknowledgement.
    readonly settle?: () => void | Promise<void>;
}

// Dispatches a message that addressed us and paints every matched automation's answer back into the chat, one painter
// per automation so two answers to one mention never share a message. A turn that fails says so in the chat, posted
// directly rather than through the painter, which owns reply text a failed turn usually has none of.
export const paintReply = async <THandle>(
    daemon: Pick<DaemonClient<unknown>, "dispatchStreaming">,
    payload: ListenerMessage,
    options: ReplyOptions<THandle>,
): Promise<void> => {
    const { surface, maxChars, onError } = options;
    const post = "stream" in surface ? async (text: string): Promise<void> => void (await surface.stream.post(text)) : surface.send;
    const painter =
        "stream" in surface
            ? () => createStreamingPainter(surface.stream, onError, { maxChars, editIntervalMs: surface.editIntervalMs })
            : () => createBufferedPainter(surface.send, onError, maxChars);
    try {
        await daemon.dispatchStreaming(
            payload,
            framePainter(painter, (reason) => void post(failureNotice(reason, maxChars)).catch(onError)),
        );
    } finally {
        await options.settle?.();
    }
};
