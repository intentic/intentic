// Decodes the daemon's H.264 stream (one WebSocket message per frame, videocast.ts) via WebCodecs' `VideoDecoder`
// into a canvas, not a <video>/MSE: MSE buffers for smooth playback, which means lag between a click and the
// picture. The daemon splits the stream and tags each message as keyframe or not; nothing here parses a bitstream.
//
// Two canvases, one picture: video paints into the lower one at the display's own pixels; a still of the settled
// page (stills.ts) paints into the upper one and shows until a frame the daemon did not mark quiet arrives, so text
// is sharp exactly while someone is reading it and the moving picture costs no scaling.

import { t } from "@intentic/ui/i18n";

// Microseconds per frame at the daemon's fixed 30fps, since chunks require an increasing timestamp.
const FRAME_US = Math.round(1_000_000 / 30);

// Still pixels per picture pixel, read off the still itself: 1 from a daemon that photographs the display's own
// pixels, 2 from one older than that, which photographed at twice the CSS pixels (a scrollbar narrower than twice
// the picture, hence rounded). Never below 1, so a still a pixel narrower than the picture is not read as half scale.
export const stillScale = (still: { readonly width: number }, picture: { readonly width: number }): number =>
    picture.width > 0 ? Math.max(1, Math.round(still.width / picture.width)) : 1;

// How many points along each edge the edge colour is read from, and how far in from the right the column is read: past
// a classic scrollbar, which is the scrollbar's grey rather than the page's own background.
const EDGE_SAMPLES = 64;
const SCROLLBAR_PX = 20;
// The share of samples one colour needs to count as the page's background rather than whatever runs to its edge.
const EDGE_MAJORITY = 0.25;

// The commonest colour among pixels, by 5 bits a channel so a video's ±1 noise on a flat white counts as one colour;
// undefined when none holds EDGE_MAJORITY of them. A pixel not fully opaque is a canvas nothing has painted yet, which
// would otherwise read as black, and counts for no colour.
export const commonColour = (pixels: Uint8ClampedArray): string | undefined => {
    const counts = new Map<number, number>();
    let best: number | undefined;
    let bestCount = 0;
    for (let at = 0; at + 3 < pixels.length; at += 4) {
        if (pixels[at + 3] !== 255) {
            continue;
        }
        const key = ((pixels[at]! >> 3) << 10) | ((pixels[at + 1]! >> 3) << 5) | (pixels[at + 2]! >> 3);
        const count = (counts.get(key) ?? 0) + 1;
        counts.set(key, count);
        if (count > bestCount) {
            bestCount = count;
            best = at;
        }
    }
    if (best === undefined || bestCount < (pixels.length / 4) * EDGE_MAJORITY) {
        return undefined;
    }
    return `rgb(${pixels[best]} ${pixels[best + 1]} ${pixels[best + 2]})`;
};

// What the pane hears from the sink besides an error.
export interface VideoSinkEvents {
    // The decoder lost the stream (a decode error closes it): only a fresh stream, with its own `ready`, paints again.
    readonly onLost?: () => void;
    // The picture painted is now this many pixels: on the first frame and on every frame of another size.
    readonly onSize?: (width: number, height: number) => void;
}

export interface VideoSink {
    // Builds the decoder for the codec the daemon reports; safe to call again, a second `ready` replaces rather than
    // stacks.
    readonly configure: (codec: string) => void;
    // `quiet`: a frame showing nothing the still on screen does not; decoded, to keep the stream whole, not painted.
    readonly push: (bytes: Uint8Array, key: boolean, quiet: boolean) => void;
    // A sharp WebP of the page as it stands; shown over the video until the page moves.
    readonly still: (bytes: Uint8Array<ArrayBuffer>) => void;
    // The page's background as its right and bottom edges show it, for what shows beside a picture smaller than its
    // box; undefined before a frame paints, or for an edge with no one colour to it.
    readonly edgeColour: () => string | undefined;
    // The picture is about to change wholesale (another tab picked): the still of what was shown goes now, along with
    // one still decoding, rather than standing over the new tab until its first frame paints.
    readonly dropStill: () => void;
    // Where to paint; the canvases mount with the component and outlive it, so they connect here, not at
    // construction. `null` is what a template ref holds once its element unmounts, so it is a value this takes.
    readonly attach: (video: HTMLCanvasElement | null, still?: HTMLCanvasElement | null) => void;
    readonly close: () => void;
}

// Safari <16.4 and Firefox <130 can't decode video; there's no fallback, so saying so beats a black rectangle.
export const canDecodeVideo = (): boolean => typeof globalThis.VideoDecoder === `function`;

// A small canvas the edges are copied into to be read: reading the picture's own canvas back makes Chromium move it off
// the GPU, which a 30 fps picture cannot afford. Made on first use, and shared, since a read is over before it returns.
let probe: CanvasRenderingContext2D | null | undefined;

// The edge colour of a painted picture: a column just inside its right edge and its bottom row, each copied into a row
// of the probe pixel for pixel, never blended.
const readEdgeColour = (source: HTMLCanvasElement): string | undefined => {
    if (source.width <= SCROLLBAR_PX || source.height < 2) {
        return undefined;
    }
    probe ??= document.createElement(`canvas`).getContext(`2d`, { willReadFrequently: true });
    if (probe === null) {
        return undefined;
    }
    probe.canvas.width = EDGE_SAMPLES;
    probe.canvas.height = EDGE_SAMPLES + 1;
    probe.imageSmoothingEnabled = false;
    probe.drawImage(source, 0, source.height - 1, source.width - SCROLLBAR_PX, 1, 0, 0, EDGE_SAMPLES, 1);
    probe.drawImage(source, source.width - SCROLLBAR_PX, 0, 1, source.height, 0, 1, 1, EDGE_SAMPLES);
    const row = probe.getImageData(0, 0, EDGE_SAMPLES, 1).data;
    const column = probe.getImageData(0, 1, 1, EDGE_SAMPLES).data;
    const both = new Uint8ClampedArray(row.length + column.length);
    both.set(row);
    both.set(column, row.length);
    return commonColour(both);
};

// Paints a decoded still over the video (`under`) and shows it. Backed at the video's shape at the still's scale, not
// the still's own shape: a still can be a scrollbar narrower or a pixel taller than the picture, and a differently shaped
// canvas would letterbox out of line with it. A strip it leaves is transparent, showing the video beneath.
const drawStill = (target: HTMLCanvasElement, under: HTMLCanvasElement, bitmap: ImageBitmap): void => {
    const scale = stillScale(bitmap, under);
    const width = under.width * scale;
    const height = under.height * scale;
    if (target.width !== width || target.height !== height) {
        target.width = width;
        target.height = height;
    }
    const layer = target.getContext(`2d`);
    if (layer === null) {
        return;
    }
    layer.clearRect(0, 0, width, height);
    layer.drawImage(bitmap, 0, 0);
    target.style.visibility = `visible`;
};

export const videoSink = (onError: (message: string) => void, events: VideoSinkEvents = {}): VideoSink => {
    let decoder: VideoDecoder | undefined;
    let canvas: HTMLCanvasElement | undefined;
    let context: CanvasRenderingContext2D | undefined;
    let stillCanvas: HTMLCanvasElement | undefined;
    let stamp = 0;
    // Deltas are dropped until a keyframe arrives: feeding the decoder a delta first throws and closes it for good.
    let awaitingKey = true;
    // Which submitted frames were quiet, by the timestamp the decoder hands back; keyed rather than queued, so a
    // frame the decoder dropped cannot shift every answer after it.
    const quietAt = new Map<number, boolean>();
    // Counts every painted motion; a still decoded across one is stale and is not shown.
    let motion = 0;

    const hideStill = (): void => {
        if (stillCanvas !== undefined) {
            stillCanvas.style.visibility = `hidden`;
        }
    };

    const paint = (frame: globalThis.VideoFrame): void => {
        if (canvas === undefined) {
            return;
        }
        // Sized from the picture, not anything the client was told, so a resize can't leave stale scaling.
        if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
            canvas.width = frame.displayWidth;
            canvas.height = frame.displayHeight;
            context = canvas.getContext(`2d`) ?? undefined;
            events.onSize?.(canvas.width, canvas.height);
        }
        context?.drawImage(frame, 0, 0);
    };

    const draw = (frame: globalThis.VideoFrame): void => {
        try {
            const quiet = quietAt.get(frame.timestamp) ?? false;
            quietAt.delete(frame.timestamp);
            // A quiet frame under a standing still adds nothing; painting it would only blur the text back.
            if (quiet && stillCanvas?.style.visibility === `visible`) {
                return;
            }
            paint(frame);
            if (!quiet) {
                motion += 1;
                hideStill();
            }
        } finally {
            // A VideoFrame holds a decoder buffer until closed; leaking one stalls the decoder within a second.
            frame.close();
        }
    };

    const teardown = (): void => {
        try {
            if (decoder !== undefined && decoder.state !== `closed`) {
                decoder.close();
            }
        } catch {
            // A decoder already closing, the state asked for.
        }
        decoder = undefined;
        quietAt.clear();
    };

    return {
        configure: (codec) => {
            teardown();
            stamp = 0;
            awaitingKey = true;
            // A new stream is a new picture (a resize, another window); the still was of the old one.
            hideStill();
            if (!canDecodeVideo()) {
                onError(t(`browsers.browserView.unsupported`));
                return;
            }
            const built = new VideoDecoder({
                output: draw,
                // A decode error closes the decoder, so the daemon is asked for a fresh stream, whose `ready` builds a new
                // one, rather than the socket torn down or the picture frozen until the next resize.
                error: () => {
                    awaitingKey = true;
                    quietAt.clear();
                    events.onLost?.();
                },
            });
            // No `description`: that's for AVCC's length-prefixed form; this is Annex-B with parameter sets repeated
            // in-band.
            built.configure({ codec, optimizeForLatency: true });
            decoder = built;
        },
        push: (bytes, key, quiet) => {
            if (decoder === undefined || decoder.state !== `configured`) {
                return;
            }
            if (awaitingKey && !key) {
                return;
            }
            awaitingKey = false;
            stamp += FRAME_US;
            quietAt.set(stamp, quiet);
            try {
                decoder.decode(new EncodedVideoChunk({ type: key ? `key` : `delta`, timestamp: stamp, data: bytes }));
            } catch {
                // A frame the decoder refused; recovery is a fresh keyframe, asked for since the periodic one is far.
                awaitingKey = true;
                quietAt.delete(stamp);
                events.onLost?.();
            }
        },
        still: (bytes) => {
            const target = stillCanvas;
            const under = canvas;
            if (target === undefined || under === undefined) {
                return;
            }
            const since = motion;
            void createImageBitmap(new Blob([bytes], { type: `image/webp` }))
                .then((bitmap) => {
                    try {
                        // Unless the page moved while this decoded: then the still is of a picture already gone.
                        if (since === motion && stillCanvas === target) {
                            drawStill(target, under, bitmap);
                        }
                    } finally {
                        bitmap.close();
                    }
                })
                .catch(() => undefined);
        },
        dropStill: () => {
            motion += 1;
            hideStill();
        },
        edgeColour: () => (canvas === undefined ? undefined : readEdgeColour(canvas)),
        attach: (video, still) => {
            // Normalised here, the one door in: everything below reads "no canvas" as undefined, and a template ref
            // hands over null the moment its element unmounts.
            canvas = video ?? undefined;
            context = video?.getContext(`2d`) ?? undefined;
            stillCanvas = still ?? undefined;
            hideStill();
        },
        close: () => {
            teardown();
            hideStill();
            canvas = undefined;
            context = undefined;
            stillCanvas = undefined;
        },
    };
};
