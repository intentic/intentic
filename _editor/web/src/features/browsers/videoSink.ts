// Decodes the daemon's H.264 stream (one WebSocket message per frame, videocast.ts) via WebCodecs' `VideoDecoder`
// into a canvas, not a <video>/MSE: MSE buffers for smooth playback, which means lag between a click and the
// picture. The daemon splits the stream and tags each message as keyframe or not; nothing here parses a bitstream.
//
// Two canvases, one picture: video paints into the lower one at the display's own pixels; a still of the settled
// page (stills.ts, at twice the CSS pixels) paints into the upper one and shows until a frame the daemon did not
// mark quiet arrives, so text is sharp exactly while someone is reading it and the moving picture costs no scaling.

// Microseconds per frame at the daemon's fixed 30fps, since chunks require an increasing timestamp.
const FRAME_US = Math.round(1_000_000 / 30);
// Pixels the still canvas holds per picture pixel: the daemon's STILL_SCALE over the display's scale, i.e. 2 CSS
// px per page px at scale 1.
const STILL_SCALE = 2;

export interface VideoSink {
    // Builds the decoder for the codec the daemon reports; safe to call again, a second `ready` replaces rather than
    // stacks.
    readonly configure: (codec: string) => void;
    // `quiet`: a frame showing nothing the still on screen does not; decoded, to keep the stream whole, not painted.
    readonly push: (bytes: Uint8Array, key: boolean, quiet: boolean) => void;
    // A sharp WebP of the page as it stands; shown over the video until the page moves.
    readonly still: (bytes: Uint8Array<ArrayBuffer>) => void;
    // Where to paint; the canvases mount with the component and outlive it, so they connect here, not at
    // construction. `null` is what a template ref holds once its element unmounts, so it is a value this takes.
    readonly attach: (video: HTMLCanvasElement | null, still?: HTMLCanvasElement | null) => void;
    readonly close: () => void;
}

// Safari <16.4 and Firefox <130 can't decode video; there's no fallback, so saying so beats a black rectangle.
export const canDecodeVideo = (): boolean => typeof globalThis.VideoDecoder === `function`;

export const videoSink = (onError: (message: string) => void): VideoSink => {
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
                onError(`This browser can't play the live view. Chrome, Edge, Safari 16.4+ or Firefox 130+ can.`);
                return;
            }
            const built = new VideoDecoder({
                output: draw,
                // A decode error is recoverable: wait for the next keyframe rather than tearing down a good socket.
                error: () => {
                    awaitingKey = true;
                    quietAt.clear();
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
                // A frame the decoder refused; recovery is just waiting for the next keyframe.
                awaitingKey = true;
                quietAt.delete(stamp);
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
                        // The page moved while this decoded; the still is of a picture already gone.
                        if (since !== motion || stillCanvas !== target) {
                            return;
                        }
                        // Backed at the video's shape scaled up, not the still's own: a still is a scrollbar narrower
                        // than the picture, and a differently shaped canvas would letterbox out of line with it. The
                        // strip it leaves is transparent, showing the video beneath.
                        const width = under.width * STILL_SCALE;
                        const height = under.height * STILL_SCALE;
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
                    } finally {
                        bitmap.close();
                    }
                })
                .catch(() => undefined);
        },
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
