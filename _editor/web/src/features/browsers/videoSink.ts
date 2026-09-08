// Decodes the daemon's H.264 stream (one WebSocket message per frame, videocast.ts) via WebCodecs' `VideoDecoder`
// into a canvas, not a <video>/MSE: MSE buffers for smooth playback, which means lag between a click and the
// picture. The daemon splits the stream and tags each message as keyframe or not; nothing here parses a bitstream.

// Microseconds per frame at the daemon's fixed 30fps, since chunks require an increasing timestamp.
const FRAME_US = Math.round(1_000_000 / 30);

export interface VideoSink {
    // Builds the decoder for the codec the daemon reports; safe to call again, a second `ready` replaces rather than
    // stacks.
    readonly configure: (codec: string) => void;
    readonly push: (bytes: Uint8Array, key: boolean) => void;
    // Where to paint; the canvas mounts with the component and outlives it, so they connect here, not at construction.
    readonly attach: (canvas: HTMLCanvasElement | undefined) => void;
    readonly close: () => void;
}

// Safari <16.4 and Firefox <130 can't decode video; there's no fallback, so saying so beats a black rectangle.
export const canDecodeVideo = (): boolean => typeof globalThis.VideoDecoder === `function`;

export const videoSink = (onError: (message: string) => void): VideoSink => {
    let decoder: VideoDecoder | undefined;
    let canvas: HTMLCanvasElement | undefined;
    let context: CanvasRenderingContext2D | undefined;
    let stamp = 0;
    // Deltas are dropped until a keyframe arrives: feeding the decoder a delta first throws and closes it for good.
    let awaitingKey = true;

    const draw = (frame: globalThis.VideoFrame): void => {
        try {
            if (canvas !== undefined) {
                // Sized from the picture, not anything the client was told, so a resize can't leave stale scaling.
                if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
                    canvas.width = frame.displayWidth;
                    canvas.height = frame.displayHeight;
                    context = canvas.getContext(`2d`) ?? undefined;
                }
                context?.drawImage(frame, 0, 0);
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
                // A decode error is recoverable: wait for the next keyframe rather than tearing down a good socket.
                error: () => {
                    awaitingKey = true;
                },
            });
            // No `description`: that's for AVCC's length-prefixed form; this is Annex-B with parameter sets repeated
            // in-band.
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
                // A frame the decoder refused; recovery is just waiting for the next keyframe.
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
