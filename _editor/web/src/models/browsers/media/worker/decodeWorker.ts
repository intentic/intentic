/* oxlint-disable unicorn/require-post-message-target-origin -- dedicated-worker postMessage has no target origin */
import { readEdgeColour } from "../../edgeColour";
import { StreamSocket } from "../../../../client/transport/streamSocket";
import { readyTransport } from "../../../../client/transport/webTransport";
import { decodeCore } from "./decodeCore";
import { mediaCarrier } from "./mediaCarrier";
import type { Surface } from "./decodeSeams";
import type { ToWorker } from "./workerWire";

// The decode worker's entry (models/browsers/media/mediaWorker.ts starts it): decodeCore with the browser's own
// WebSocket (or WebTransport, mediaCarrier.ts), WebCodecs and OffscreenCanvas. Everything it decides is in decodeCore
// and the modules it composes.

// A small canvas the picture's edges are copied into to be read (edgeColour.ts); made on first use.
let probe: OffscreenCanvasRenderingContext2D | null | undefined;

// The worker's own canvases are OffscreenCanvases, which is all a Surface is.
const offscreen = (surface: Surface): OffscreenCanvas | undefined => (surface instanceof OffscreenCanvas ? surface : undefined);

const core = decodeCore({
    post: (message) => self.postMessage(message),
    dial: mediaCarrier({
        session: (base, graceMs) => readyTransport(base, true, graceMs),
        webSocket: (url) => new WebSocket(url),
        streamSocket: (opening, request) => new StreamSocket(opening, request),
    }),
    videoDecoder: (init) => new VideoDecoder(init),
    audioDecoder: (init) => (`AudioDecoder` in self ? new AudioDecoder(init) : undefined),
    videoChunk: (init) => new EncodedVideoChunk(init),
    audioChunk: (init) => new EncodedAudioChunk(init),
    bgrxFrame: (pixels, width, height) => new VideoFrame(pixels, { format: `BGRX`, codedWidth: width, codedHeight: height, timestamp: 0 }),
    imageData: (rgba, width, height) => new ImageData(rgba, width, height),
    surface: (width, height) => new OffscreenCanvas(Math.max(1, width), Math.max(1, height)),
    snapshot: async (canvas) => {
        const source = offscreen(canvas);
        // allow(silent-catch): a canvas that cannot be copied (zero-sized, lost) leaves its tab with no last picture.
        return source === undefined ? undefined : createImageBitmap(source).catch(() => undefined);
    },
    edge: (canvas) => {
        const source = offscreen(canvas);
        probe ??= new OffscreenCanvas(1, 1).getContext(`2d`, { willReadFrequently: true });
        return source === undefined || probe === null ? undefined : readEdgeColour(source, probe);
    },
    now: () => performance.now(),
    every: (ms, run) => {
        const timer = setInterval(run, ms);
        return () => clearInterval(timer);
    },
});

self.addEventListener(`message`, (event: MessageEvent<ToWorker>) => core.receive(event.data));
