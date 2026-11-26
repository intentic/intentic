import type { DemoSocket } from "./transport";

// A live picture the way the daemon's videocast.ts sends one: a `ready` naming the codec, then one binary message per
// encoded frame, tagged keyframe (3) or delta (4); or, on another wire (CastWire), the way a connected computer's
// remoted sends its screen on a media socket (deviceScreen.ts). The daemon encodes its display with ffmpeg; the demo draws its own
// picture on a canvas and encodes it with the browser's WebCodecs, VP8, which every browser that can decode the stream
// can also encode. The editor reads the codec from `ready`, so it decodes this exactly as it decodes a daemon's H.264.

const TAG_KEY = 3;
const TAG_DELTA = 4;
const FPS = 6;
// A keyframe this often, so a view that dropped a frame recovers within a couple of seconds.
const KEY_EVERY = 12;
const CODEC = `vp8`;

export type Painter = (context: OffscreenCanvasRenderingContext2D, now: number) => void;

/** How the picture is said on the socket: the message that opens it, and one encoded frame as its binary message. */
export interface CastWire {
    readonly opening: (size: { readonly width: number; readonly height: number }, codec: string) => string;
    readonly frame: (payload: Uint8Array, key: boolean, index: number) => ArrayBuffer;
}

// The window socket's own: a `ready`, and each frame behind one byte saying keyframe or delta.
const READY_WIRE: CastWire = {
    opening: (size, codec) => JSON.stringify({ type: `ready`, kind: `video`, width: size.width, height: size.height, codec }),
    frame: (payload, key) => {
        const wire = new Uint8Array(payload.byteLength + 1);
        wire[0] = key ? TAG_KEY : TAG_DELTA;
        wire.set(payload, 1);
        return wire.buffer;
    },
};

export interface VideoCast {
    // Draw and send a frame now, out of turn: an input the picture should answer at once.
    readonly repaint: () => void;
    // The next frame is a keyframe: a viewer's decoder lost its place.
    readonly keyframe: () => void;
    readonly pause: () => void;
    readonly resume: () => void;
    readonly stop: () => void;
}

const canEncode = (): boolean => `VideoEncoder` in globalThis && `OffscreenCanvas` in globalThis;

/** Streams `paint`'s picture on the socket until it closes; a browser that cannot encode is told nothing will paint. */
export const startVideoCast = (
    socket: DemoSocket,
    size: { readonly width: number; readonly height: number },
    paint: Painter,
    wire: CastWire = READY_WIRE,
): VideoCast => {
    socket.emit(wire.opening(size, CODEC));
    if (!canEncode()) {
        socket.emit(JSON.stringify({ type: `error`, message: `This browser cannot encode video, so the demo cannot draw this picture here.` }));
        const idle = (): void => undefined;
        return { repaint: idle, keyframe: idle, pause: idle, resume: idle, stop: idle };
    }
    const canvas = new OffscreenCanvas(size.width, size.height);
    const context = canvas.getContext(`2d`);
    let frames = 0;
    let sent = 0;
    let keyOwed = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    const encoder = new VideoEncoder({
        output: (chunk) => {
            const payload = new Uint8Array(chunk.byteLength);
            chunk.copyTo(payload);
            socket.emit(wire.frame(payload, chunk.type === `key`, sent));
            sent += 1;
        },
        error: () => clearInterval(timer),
    });
    encoder.configure({ codec: CODEC, width: size.width, height: size.height, bitrate: 1_500_000, framerate: FPS, latencyMode: `realtime` });
    const send = (): void => {
        if (context === null || encoder.state !== `configured`) {
            return;
        }
        paint(context, Date.now());
        const frame = new VideoFrame(canvas, { timestamp: (frames * 1_000_000) / FPS });
        encoder.encode(frame, { keyFrame: keyOwed || frames % KEY_EVERY === 0 });
        keyOwed = false;
        frame.close();
        frames += 1;
    };
    const resume = (): void => {
        clearInterval(timer);
        // A picture resumed starts on a keyframe, as a fresh decoder needs.
        frames = Math.ceil(frames / KEY_EVERY) * KEY_EVERY;
        send();
        timer = setInterval(send, 1000 / FPS);
    };
    const stop = (): void => {
        clearInterval(timer);
        if (encoder.state !== `closed`) {
            encoder.close();
        }
    };
    resume();
    socket.addEventListener(`close`, stop);
    return {
        repaint: send,
        keyframe: () => {
            keyOwed = true;
        },
        pause: () => clearInterval(timer),
        resume,
        stop,
    };
};
