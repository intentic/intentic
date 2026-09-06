/* THE BROWSER'S BROWSER, DECODED — H.264 off the socket, painted into a canvas.
 *
 * The daemon grabs the agent's X display and sends one WebSocket message per encoded frame (videocast.ts). This
 * is the other end: a WebCodecs `VideoDecoder` fed those frames and a canvas it draws into.
 *
 * WHY WEBCODECS AND NOT A <video>. The obvious route is Media Source Extensions — wrap the stream in fragmented
 * MP4, append it to a SourceBuffer, let the element play it. It works, and it buys a pipeline built for
 * PLAYBACK: MSE holds a buffer so playback is smooth, which for a recording is the whole point and for a
 * browser somebody is trying to click is a hundred to several hundred milliseconds of lag between the hand and
 * the picture. `VideoDecoder` has no such notion; a frame is decoded when it arrives and drawn when it decodes.
 * There is no seeking, no buffering and no playback rate here because none of those mean anything for a
 * picture of something happening now.
 *
 * NOTHING PARSES A BITSTREAM HERE. The daemon splits the stream on access-unit delimiters and tags each message
 * as a keyframe or not, so this receives whole frames and is told which can start a decode — the one fact a
 * decoder cannot recover for itself.
 */

// How long one frame is worth, in the microseconds VideoDecoder counts in. The daemon captures at a fixed 30fps
// and there are no B-frames (the encoder is `-tune zerolatency`), so presentation order is decode order and a
// synthetic clock is as good as a real one. It exists only because chunks must carry an increasing timestamp.
const FRAME_US = Math.round(1_000_000 / 30);

export interface VideoSink {
    // Build the decoder for the codec the daemon read out of its own stream. Safe to call again: a second
    // `ready` (a resumed stream, a reconnect) replaces the decoder rather than stacking one.
    readonly configure: (codec: string) => void;
    readonly push: (bytes: Uint8Array, key: boolean) => void;
    // Where to paint. The canvas mounts with the component and this composable outlives it, so the two are
    // connected here rather than at construction.
    readonly attach: (canvas: HTMLCanvasElement | undefined) => void;
    readonly close: () => void;
}

// Whether this browser can decode video at all. Safari before 16.4 and Firefox before 130 cannot, and there is
// no second implementation to fall back to — saying so beats a permanently black rectangle.
export const canDecodeVideo = (): boolean => typeof globalThis.VideoDecoder === `function`;

export const videoSink = (onError: (message: string) => void): VideoSink => {
    let decoder: VideoDecoder | undefined;
    let canvas: HTMLCanvasElement | undefined;
    let context: CanvasRenderingContext2D | undefined;
    let stamp = 0;
    /* THE DECODER IS USELESS UNTIL A KEYFRAME, and feeding it a delta first is not a no-op: it throws, and the
     * decoder ends up in a closed state that every later frame also fails against. So deltas are dropped until
     * one arrives — which normally means the very first frame, because each viewer gets an encoder of its own
     * whose first output is a keyframe, and otherwise means the two seconds until the next one. */
    let awaitingKey = true;

    const draw = (frame: globalThis.VideoFrame): void => {
        try {
            if (canvas !== undefined) {
                // Sized from the picture rather than from anything the client was told, so a display whose size
                // changed cannot leave the canvas scaling every frame by a stale factor.
                if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
                    canvas.width = frame.displayWidth;
                    canvas.height = frame.displayHeight;
                    context = canvas.getContext(`2d`) ?? undefined;
                }
                context?.drawImage(frame, 0, 0);
            }
        } finally {
            // A VideoFrame holds a decoder buffer until it is closed, and there are only a handful of them:
            // leaking one stalls the whole decoder within a second, which reads as the picture freezing.
            frame.close();
        }
    };

    const teardown = (): void => {
        try {
            if (decoder !== undefined && decoder.state !== `closed`) {
                decoder.close();
            }
        } catch {
            // a decoder that was already closing, which is the state asked for
        }
        decoder = undefined;
    };

    return {
        configure: (codec) => {
            teardown();
            stamp = 0;
            awaitingKey = true;
            if (!canDecodeVideo()) {
                onError(`This browser can't play the live view. Chrome, Edge, Safari 16.4+ or Firefox 130+ can.`);
                return;
            }
            const built = new VideoDecoder({
                output: draw,
                // A decode error is recoverable: drop back to waiting for a keyframe and rebuild on the next
                // one, rather than tearing down a socket that is still perfectly good.
                error: () => {
                    awaitingKey = true;
                },
            });
            // No `description`: that field is for the length-prefixed AVCC form, and this stream is Annex-B
            // with its parameter sets in band (the daemon repeats them at every keyframe for exactly this).
            built.configure({ codec, optimizeForLatency: true });
            decoder = built;
        },
        push: (bytes, key) => {
            if (decoder === undefined || decoder.state !== `configured`) {
                return;
            }
            if (awaitingKey && !key) {
                return;
            }
            awaitingKey = false;
            stamp += FRAME_US;
            try {
                decoder.decode(new EncodedVideoChunk({ type: key ? `key` : `delta`, timestamp: stamp, data: bytes }));
            } catch {
                // A frame the decoder would not take. The next keyframe is two seconds away at worst, and
                // waiting for it is the whole recovery.
                awaitingKey = true;
            }
        },
        attach: (next) => {
            canvas = next;
            context = next?.getContext(`2d`) ?? undefined;
        },
        close: () => {
            teardown();
            canvas = undefined;
            context = undefined;
        },
    };
};
