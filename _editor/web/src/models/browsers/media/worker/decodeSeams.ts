import type { Still } from "../stillCache";
import type { FromWorker } from "./workerWire";

// What the decode worker (decodeCore.ts) touches of its world, handed in: the worker's entry (decodeWorker.ts) hands
// the browser's own, and the tests hand fakes. Each is as narrow as the worker's use of it.

/** What the worker draws on: an OffscreenCanvas, as far as the worker uses one. */
export interface Surface {
    width: number;
    height: number;
    getContext(kind: `2d`, options?: CanvasRenderingContext2DSettings): Painter | null;
}

/** A decoded picture as the worker handles one: a VideoFrame, as far as it is read, drawn and let go of. */
export interface FrameLike {
    readonly timestamp: number;
    // Its size as drawn: a stripe's is the picture's width and its own rows.
    readonly displayWidth: number;
    readonly displayHeight: number;
    close(): void;
}

/** Pixels a painter puts as they are: an ImageData, as far as the worker makes one. */
export interface PixelsLike {
    readonly width: number;
    readonly height: number;
    readonly data: Uint8ClampedArray;
}

/** Anything the worker draws: a picture source, one of its own canvases, a decoded frame. */
export type Drawable = CanvasImageSource | Surface | FrameLike;

/** A 2D context, as far as the worker draws with one. Methods, so either canvas's own context is one. */
export interface Painter {
    drawImage(image: Drawable, dx: number, dy: number): void;
    drawImage(image: Drawable, dx: number, dy: number, dw: number, dh: number): void;
    drawImage(image: Drawable, sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, dw: number, dh: number): void;
    putImageData(pixels: PixelsLike, dx: number, dy: number): void;
}

/** An encoded chunk, as far as the worker's decoders are handed one. */
export interface ChunkLike {
    readonly type: EncodedVideoChunkType;
    readonly timestamp: number;
}

/** What a video decoder is built with: where its frames go, and what it says when it fails. */
export interface VideoDecoderInitLike {
    output(frame: FrameLike): void;
    error(error: DOMException): void;
}

/** A remembered picture: a still the canvas can draw, sized, and closed when let go of. */
export type StillPicture = Still & CanvasImageSource;

export interface SocketLike {
    binaryType: BinaryType;
    readonly readyState: number;
    send(data: string): void;
    close(): void;
    addEventListener(type: `open`, listener: () => void): void;
    addEventListener(type: `close`, listener: (event: { readonly code: number; readonly reason: string }) => void): void;
    addEventListener(type: `message`, listener: (event: { readonly data: string | ArrayBuffer | Blob }) => void): void;
}

export interface CodecLike<Config, Chunk> {
    readonly state: CodecState;
    configure(config: Config): void;
    decode(chunk: Chunk): void;
    close(): void;
}

export type VideoDecoderLike = CodecLike<VideoDecoderConfig, ChunkLike>;
export type AudioDecoderLike = CodecLike<AudioDecoderConfig, EncodedAudioChunk>;

export interface DecodeSeams {
    readonly post: (message: FromWorker) => void;
    // The media socket at `url`, on a stream of the edge's WebTransport session when `transport` and one is ready.
    readonly dial: (url: string, transport: boolean) => SocketLike | Promise<SocketLike>;
    readonly videoDecoder: (init: VideoDecoderInitLike) => VideoDecoderLike;
    // Undefined where the browser has no AudioDecoder: the picture plays without its sound.
    readonly audioDecoder: (init: AudioDecoderInit) => AudioDecoderLike | undefined;
    readonly videoChunk: (init: EncodedVideoChunkInit) => ChunkLike;
    readonly audioChunk: (init: EncodedAudioChunkInit) => EncodedAudioChunk;
    // A picture of castd's exact pixels (B, G, R, unused), as a VideoFrame; throws where the browser makes none of them.
    readonly bgrxFrame: (pixels: Uint8Array<ArrayBuffer>, width: number, height: number) => FrameLike;
    // The same pixels turned to RGBA, for a browser that makes no such VideoFrame.
    readonly imageData: (rgba: Uint8ClampedArray<ArrayBuffer>, width: number, height: number) => PixelsLike;
    // A canvas of the worker's own (what a tab switch draws the live picture onto behind its still).
    readonly surface: (width: number, height: number) => Surface | undefined;
    // A copy of what a canvas shows now, for the tabs' last pictures.
    readonly snapshot: (canvas: Surface) => Promise<StillPicture | undefined>;
    readonly edge: (canvas: Surface) => string | undefined;
    readonly now: () => number;
    readonly every: (ms: number, run: () => void) => () => void;
}

/** Closes a codec unless it is closed already; one closing under the call is the state asked for. */
export const closeCodec = (codec: { readonly state: CodecState; close(): void } | undefined): void => {
    try {
        if (codec !== undefined && codec.state !== `closed`) {
            codec.close();
        }
    } catch {
        // allow(silent-catch): a codec already closing is the state asked for.
    }
};
