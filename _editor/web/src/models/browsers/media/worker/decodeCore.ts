import type { DecodeSeams, Surface } from "./decodeSeams";
import { captureClock, type MediaStats, statsBook } from "../frameBook";
import { mediaPayload, readExactCopy, readMediaHeader, readVideo } from "../mediaHeader";
import { type MediaHello, readMediaText } from "../mediaMessages";
import { type PictureCanvas, pictureCanvas } from "./pictureCanvas";
import { soundDecode } from "./soundDecode";
import { type StripeVideo, stripeVideo } from "./stripeVideo";
import { workerSocket } from "./workerSocket";
import type { ToWorker } from "./workerWire";

// THE DECODE WORKER: one media socket, its picture and its sound, off the page's main thread. Every video message is
// one stripe of one frame (stripeVideo.ts), decoded and drawn at its top row on the canvas the page transferred
// (pictureCanvas.ts), and acked with its decode time, since castd steers its bitrate on acks; sound is decoded and
// posted straight to the audio thread (soundDecode.ts). The page hears only what it acts on (workerWire.ts). The socket
// asks for an exact picture, which castd sends only to a viewer on its own computer: a clipped frame is drawn only
// inside its clip, and castd's exact copy of a rectangle once every frame sent before it is drawn (exactPicture.ts).
//
// The stream arrives on one of two carriers, the socket or the page's peer connection (mediaRtc.ts), and castd says
// `hello` on whichever it moves the stream onto: pictures and sound count only from the carrier of the latest hello,
// so a frame still in flight on the one it left is never drawn after the new stream's keyframe.

// How often the worker measures the round trip itself, while stats are shown and otherwise, and how often it settles
// frames whose outputs never came.
const PING_SHOWN_MS = 1000;
const PING_HIDDEN_MS = 5000;
const TICK_MS = 250;
const STATS_MS = 500;

// Which way a message from castd came: the media socket, or the page's peer connection.
type Carrier = `socket` | `peer`;

// castd's own account of the stream, from its last `stats`.
type CastdWord = Pick<MediaStats, `targetKbps` | `queueMs` | `sentFps`>;

// One handler per message the page sends, each taking its own.
type Handlers = { readonly [Type in ToWorker[`type`]]: (message: Extract<ToWorker, { type: Type }>) => void };

export interface DecodeCore {
    readonly receive: (message: ToWorker) => void;
}

// A canvas the page handed over starts blank, and a stream under way repaints only the stripes that change (and, for an
// exact picture, only the clip within them): a picture that came before it (castd's keyframe can beat the page's
// canvas, which mounts on the hello) asks for a keyframe, which castd sends whole, the exact picture started over.
const attachCanvas = (canvas: PictureCanvas, video: StripeVideo, surface: Surface | undefined): void => {
    canvas.attach(surface);
    if (surface !== undefined) {
        video.repaint();
    }
};

// What a stream reads into: the decoders, the canvas, the clocks and the socket's round trip.
interface StreamParts {
    readonly now: () => number;
    readonly clock: ReturnType<typeof captureClock>;
    readonly stats: ReturnType<typeof statsBook>;
    readonly video: ReturnType<typeof stripeVideo>;
    readonly sound: ReturnType<typeof soundDecode>;
    readonly canvas: ReturnType<typeof pictureCanvas>;
    readonly pong: (t: number) => void;
}

// castd's messages, from either carrier, into the stream's parts: its JSON (the hello that starts a stream and names
// its carrier, pongs, castd's stats) and its pictures and sound, only from that carrier.
const streamReader = (parts: StreamParts) => {
    let hello: MediaHello | undefined;
    let castd: CastdWord = {};
    let carrier: Carrier = `socket`;
    return {
        hello: () => hello,
        castd: () => castd,
        // A new socket is a new viewer of castd's: whatever peer the last one had went with it.
        dialled: (): void => {
            carrier = `socket`;
        },
        reset: (): void => {
            carrier = `socket`;
            hello = undefined;
        },
        text: (data: string, from: Carrier): void => {
            const message = readMediaText(data);
            if (message?.type === `hello`) {
                carrier = from;
                hello = message;
                parts.clock.hello();
                // A fresh stream: its frame ids, stripes and decoders start over, and its first keyframe follows.
                parts.video.start(message.codec);
                parts.sound.start(message.audio);
                parts.canvas.start(message.width, message.height);
            } else if (message?.type === `pong`) {
                parts.pong(message.t);
            } else if (message?.type === `stats`) {
                castd = { targetKbps: message.targetKbps, queueMs: message.queueMs, sentFps: message.fps };
            }
        },
        binary: (data: ArrayBuffer, from: Carrier): void => {
            if (from !== carrier) {
                return;
            }
            const bytes = new Uint8Array(data);
            const header = readMediaHeader(bytes);
            parts.stats.bytes(parts.now(), bytes.byteLength);
            if (header?.kind === `video`) {
                parts.clock.arrived(header.captureMs);
                const { unit, clip } = readVideo(header, bytes);
                parts.video.push(header, unit, clip);
            } else if (header?.kind === `audio`) {
                parts.sound.push(mediaPayload(bytes));
            } else if (header?.kind === `lossless`) {
                // Neither decoded nor acked: drawn after the frames castd sent before it, never under them.
                const copy = readExactCopy(bytes);
                if (copy !== undefined) {
                    parts.video.after(header.id, () => parts.canvas.exact(copy));
                }
            }
        },
    };
};

export const decodeCore = (seams: DecodeSeams): DecodeCore => {
    const clock = captureClock(seams.now);
    const stats = statsBook();
    const canvas = pictureCanvas(seams, (captureMs) => stats.drawn(seams.now(), clock.age(captureMs, (socket.rttMs() ?? 0) / 2)));
    const sound = soundDecode(seams);
    const video = stripeVideo(seams, { draw: canvas.draw, send: (message) => socket.send(message), decoded: (ms) => stats.decoded(seams.now(), ms) });
    const stream = streamReader({ now: seams.now, clock, stats, video, sound, canvas, pong: (t) => socket.pong(t) });
    const socket = workerSocket(seams, { text: (data) => stream.text(data, `socket`), binary: (data) => stream.binary(data, `socket`) });

    const postStats = (): void =>
        seams.post({
            type: `stats`,
            stats: stats.snapshot(seams.now(), {
                rttMs: socket.rttMs(),
                ...stream.castd(),
                dropped: video.dropped(),
                width: stream.hello()?.width ?? 0,
                height: stream.hello()?.height ?? 0,
                scale: stream.hello()?.scale ?? 1,
                stripes: video.stripes(),
            }),
        });

    seams.every(TICK_MS, () => {
        video.sweep();
        canvas.tabs.tick();
    });
    let stopPing = seams.every(PING_HIDDEN_MS, socket.ping);
    let stopStats: (() => void) | undefined;
    const showStats = (on: boolean): void => {
        stopStats?.();
        stopStats = on ? seams.every(STATS_MS, postStats) : undefined;
        stopPing();
        stopPing = seams.every(on ? PING_SHOWN_MS : PING_HIDDEN_MS, socket.ping);
        if (on) {
            postStats();
        }
    };

    const reset = (): void => {
        canvas.reset();
        socket.hangup();
        stream.reset();
        stats.reset();
        video.close();
        sound.close();
    };

    const handlers: Handlers = {
        dial: (message) => {
            stream.dialled();
            socket.dial(message.socket, message.url, message.transport);
        },
        hangup: (message) => socket.hangup(message.socket),
        // The page's keepalive is answered on this thread's clock, so its round trip is measured here.
        send: (message) => (message.message.type === `ping` ? socket.ping() : socket.send(message.message)),
        canvas: (message) => attachCanvas(canvas, video, message.canvas),
        audio: (message) => sound.port(message.port),
        page: (message) => canvas.tabs.show(message.key, message.switching),
        fronted: (message) => canvas.tabs.fronted(message.key, clock.castdNow()),
        stats: (message) => showStats(message.on),
        edge: () => seams.post({ type: `edge`, colour: canvas.edge() }),
        reset,
        peer: (message) => socket.peer(message.open),
        peerData: (message) => (message.data instanceof ArrayBuffer ? stream.binary(message.data, `peer`) : stream.text(message.data, `peer`)),
    };

    return {
        // SAFETY: `handlers` holds one handler per message type, keyed by that type, so the one picked takes this message.
        receive: (message) => (handlers[message.type] as (message: ToWorker) => void)(message),
    };
};
