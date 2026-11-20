import { errorMessage } from "@intentic/base/errors";
import type { BrowserMediaClientMessage } from "@intentic/sandbox-contract/browser-wire";
import { closeCodec, type DecodeSeams, type FrameLike, type VideoDecoderLike } from "./decodeSeams";
import { type Ack, ackBook, type FrameQueue, frameQueue } from "../frameBook";
import type { MediaHeader, PictureRect } from "../mediaHeader";

// THE PICTURE'S DECODERS: one VideoDecoder per stripe, since each stripe is an H.264 stream of its own (castd encodes
// them in parallel and sends only those that changed), each frame acked once every stripe of it that came has
// decoded (frameBook.ts). A stripe's decoder is built at its first keyframe; one that fails is closed for good, its
// stripe waits for a keyframe, and one is asked for (keyframePolicy below). What waits for the frames before it (castd's
// exact copies, exactPicture.ts) runs once each of them came out of its decoder or was given up.

/** A decoded stripe, for the canvas: drawn at its top row; closed by whoever draws it. */
export interface DecodedStripe {
    readonly frame: FrameLike;
    readonly top: number;
    readonly captureMs: number;
    // Drawn only inside this rectangle of the picture, where castd clipped its frame; undefined draws it whole.
    readonly clip?: PictureRect;
}

export interface StripeVideoIo {
    readonly draw: (decoded: DecodedStripe) => void;
    readonly send: (message: BrowserMediaClientMessage) => void;
    readonly decoded: (decodeMs: number) => void;
}

export interface StripeVideo {
    // A `hello`: the stream starts over, every stripe at its next keyframe, on this codec.
    readonly start: (codec: string) => void;
    // One stripe's access unit, drawn inside `clip` where castd clipped its frame.
    readonly push: (header: MediaHeader, payload: Uint8Array, clip?: PictureRect) => void;
    // Runs `then` once every frame up to `id` that reached a decoder has come out of it or been given up; dropped, never
    // run, when the stream starts over.
    readonly after: (id: number, then: () => void) => void;
    // Settles frames whose outputs were lost, and sends a keyframe ask the rate limit held back; on the worker's tick.
    readonly sweep: () => void;
    // The picture's canvas was replaced: a stream under way repaints only the stripes that change, so the rest of a
    // fresh canvas needs a keyframe.
    readonly repaint: () => void;
    readonly dropped: () => number;
    readonly stripes: () => number;
    readonly close: () => void;
}

// A keyframe is asked at most this often: each is a burst for every viewer of the window.
const KEYFRAME_EVERY_MS = 500;

interface Stripe {
    decoder: VideoDecoderLike | undefined;
    top: number;
    // Deltas are dropped until a keyframe: a delta fed first throws and closes the decoder for good.
    awaitingKey: boolean;
    stamp: number;
    // What each chunk in the decoder was, by the timestamp it comes back with.
    readonly sent: Map<number, { readonly id: number; readonly captureMs: number; readonly clip: PictureRect | undefined }>;
}

// Says on the socket each ack a settle completed, hands its decode time to the stats, and runs what waited on the
// frames it settled.
const acker =
    (io: StripeVideoIo, waiting: FrameQueue) =>
    (...settled: readonly (Ack | undefined)[]): void => {
        for (const done of settled) {
            if (done !== undefined) {
                io.send(done.decodeMs === undefined ? { type: `ack`, id: done.id } : { type: `ack`, id: done.id, decodeMs: done.decodeMs });
            }
            if (done?.decodeMs !== undefined) {
                io.decoded(done.decodeMs);
            }
        }
        waiting.drain();
    };

// WHEN CASTD IS ASKED FOR A KEYFRAME. castd never sends one unasked (its GOP is endless), so an ask the rate limit
// holds back is owed, and goes on the first tick the limit allows; dropped, it left a stripe whose decoder failed just
// after a keyframe waiting for one forever. A codec this browser refuses outright is said to the page once and asked
// for no more, since every keyframe would be refused the same way. A fresh canvas asks only once pictures came.
const keyframePolicy = (seams: Pick<DecodeSeams, `now` | `post`>, send: StripeVideoIo[`send`]) => {
    let askedAt = Number.NEGATIVE_INFINITY;
    let owed = false;
    let seen = false;
    let refused = false;
    const ask = (): void => {
        owed = !refused && seams.now() - askedAt < KEYFRAME_EVERY_MS;
        if (!owed && !refused) {
            askedAt = seams.now();
            send({ type: `keyframe` });
        }
    };
    const refuse = (message: string): void => {
        if (!refused) {
            refused = true;
            seams.post({ type: `failed`, message });
        }
    };
    return {
        ask,
        refuse,
        refused: () => refused,
        saw: (): void => {
            seen = true;
        },
        // A stripe's decoder closed under it, with the decoder's error where it said one.
        lost: (error?: DOMException): void => (error?.name === `NotSupportedError` ? refuse(errorMessage(error)) : ask()),
        repaint: (): void => (seen ? ask() : undefined),
        tick: (): void => (owed ? ask() : undefined),
        // A fresh stream: nothing owed or seen yet, and its codec not refused yet.
        reset: (): void => {
            [owed, seen, refused] = [false, false, false];
        },
    };
};

// The stripe at the header's index, made at its first message.
const stripeOf = (stripes: Map<number, Stripe>, header: MediaHeader): Stripe => {
    const stripe = stripes.get(header.stripeIndex) ?? { decoder: undefined, top: 0, awaitingKey: true, stamp: 0, sent: new Map() };
    stripes.set(header.stripeIndex, stripe);
    stripe.top = header.stripeTop;
    return stripe;
};

export const stripeVideo = (seams: Pick<DecodeSeams, `videoDecoder` | `videoChunk` | `now` | `post`>, io: StripeVideoIo): StripeVideo => {
    const stripes = new Map<number, Stripe>();
    const acks = ackBook();
    const keyframe = keyframePolicy(seams, io.send);
    const waiting = frameQueue(acks.settledThrough);
    let codec = ``;

    const ack = acker(io, waiting);

    const lose = (index: number, stripe: Stripe, error?: DOMException): void => {
        closeCodec(stripe.decoder);
        stripe.decoder = undefined;
        stripe.awaitingKey = true;
        stripe.sent.clear();
        // A decoder of a stream since replaced: whatever waits on this index now is the new stream's.
        if (stripes.get(index) === stripe) {
            ack(...acks.lostStripe(index, seams.now()));
            keyframe.lost(error);
        }
    };

    const build = (index: number, stripe: Stripe): void => {
        try {
            const decoder = seams.videoDecoder({
                output: (frame) => {
                    const sent = stripe.sent.get(frame.timestamp);
                    stripe.sent.delete(frame.timestamp);
                    if (sent === undefined || stripes.get(index) !== stripe) {
                        frame.close();
                        return;
                    }
                    io.draw({ frame, top: stripe.top, captureMs: sent.captureMs, clip: sent.clip });
                    ack(acks.settled(sent.id, index, seams.now(), true));
                },
                error: (error) => lose(index, stripe, error),
            });
            // Annex B with the parameter sets in band, so no `description`.
            decoder.configure({ codec, optimizeForLatency: true });
            stripe.decoder = decoder;
        } catch (error) {
            keyframe.refuse(errorMessage(error));
        }
    };

    const push = (header: MediaHeader, payload: Uint8Array, clip?: PictureRect): void => {
        const now = seams.now();
        const index = header.stripeIndex;
        const stripe = stripeOf(stripes, header);
        acks.arrived(header.id, index, now);
        keyframe.saw();
        if (header.key && !keyframe.refused() && stripe.decoder?.state !== `configured`) {
            build(index, stripe);
        }
        const decoder = stripe.decoder;
        if ((stripe.awaitingKey && !header.key) || decoder?.state !== `configured`) {
            ack(acks.settled(header.id, index, now, false));
            return;
        }
        stripe.awaitingKey = false;
        stripe.stamp += 1;
        stripe.sent.set(stripe.stamp, { id: header.id, captureMs: header.captureMs, clip });
        try {
            decoder.decode(seams.videoChunk({ type: header.key ? `key` : `delta`, timestamp: stripe.stamp, data: payload }));
        } catch {
            // A chunk the decoder refused: the stripe starts over at a keyframe.
            ack(acks.settled(header.id, index, now, false));
            lose(index, stripe);
        }
    };

    const close = (): void => {
        for (const stripe of stripes.values()) {
            closeCodec(stripe.decoder);
        }
        stripes.clear();
        acks.reset();
        waiting.drop();
        keyframe.reset();
    };

    return {
        start: (next) => {
            close();
            codec = next;
        },
        push,
        after: waiting.after,
        sweep: () => {
            ack(...acks.sweep(seams.now()));
            keyframe.tick();
        },
        repaint: keyframe.repaint,
        dropped: acks.dropped,
        stripes: () => stripes.size,
        close,
    };
};
