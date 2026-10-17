import { Readable } from "node:stream";
import { promisify } from "node:util";
import {
    brotliCompress,
    constants,
    createBrotliCompress,
    createGzip,
    createZstdCompress,
    gzip,
    zstdCompress,
    type BrotliCompress,
    type Gzip,
    type ZstdCompress,
} from "node:zlib";
import { webStream } from "@intentic/base/web-stream";

// The codings the daemon sends and what each costs, shared by the answer middleware (compress-responses.ts) and the
// public outbox (public/public-serve.ts). The levels are measured, not guessed: on the daemon's own payloads (a 2.9 MB
// transcript, a 1.4 MB file tree, a 3.6 MB JS bundle, a 24 KB answer) zstd 3 delivers fastest at 50 and 200 Mbit/s,
// encoding at ~400 MB/s to within a few percent of brotli 5's size; brotli 5 and gzip 6 sit on the same curve for a
// browser without zstd. A higher level only pays on a link slower than ~10 Mbit/s, and then by 5-8%.

export type Coding = "zstd" | "br" | "gzip";

// Below this an answer fits a packet or two either way, and encoding costs more than it saves.
export const MIN_COMPRESSED_BYTES = 1024;

// Cheapest to encode first; at these levels each shrinks the daemon's JSON about sevenfold.
const PREFERENCE: readonly Coding[] = ["zstd", "br", "gzip"];

// The best coding the request accepts; a coding named with q=0 is refused, anything else named is accepted.
export const codingFor = (acceptEncoding: string | undefined): Coding | undefined => {
    const accepted = new Set(
        (acceptEncoding ?? "")
            .split(",")
            .map((entry) => entry.trim().toLowerCase().split(";"))
            .filter(([, quality]) => quality === undefined || !/^\s*q\s*=\s*0(\.0*)?\s*$/u.test(quality))
            .map(([name]) => name),
    );
    return PREFERENCE.find((coding) => accepted.has(coding));
};

export const isJson = (contentType: string | null): boolean => contentType !== null && /^application\/([\w.+-]*\+)?json\b/iu.test(contentType);

// Text an encoder shrinks three- to tenfold: JSON, every text/* (HTML, CSS, JS, plain, markdown, CSV, an event stream),
// script and XML under application/, and newline-delimited JSON. An image never, SVG included: the routes that answer
// with image types send file bytes whose Content-Length the browser counts progress against.
export const isCompressibleText = (contentType: string | null): boolean =>
    contentType !== null &&
    (isJson(contentType) ||
        /^text\//iu.test(contentType) ||
        /^application\/(javascript|ecmascript|x-javascript|xml|x-ndjson|([\w.-]+\+xml))\b/iu.test(contentType));

// A body whose chunks are frames a reader acts on one by one: each must leave the moment it is written.
export const isEventStream = (contentType: string | null): boolean =>
    contentType !== null && /^(text\/event-stream|application\/x-ndjson)\b/iu.test(contentType);

// One-shot levels for an answer encoded as it is sent: single milliseconds on a megabyte, run on libuv's pool, off
// the daemon's loop.
const dynamicEncoders = {
    zstd: (body) => promisify(zstdCompress)(body, { params: { [constants.ZSTD_c_compressionLevel]: 3 } }),
    br: (body) =>
        promisify(brotliCompress)(body, {
            params: { [constants.BROTLI_PARAM_QUALITY]: 5, [constants.BROTLI_PARAM_SIZE_HINT]: body.byteLength },
        }),
    gzip: (body) => promisify(gzip)(body, { level: 6 }),
} satisfies Record<Coding, (body: Buffer) => Promise<Buffer>>;

// Levels for a body encoded once and sent many times (a script every visitor of a customer's page loads): a second
// or so of the pool per megabyte, spent once, for 10-15% fewer bytes than the dynamic level on every send after.
const staticEncoders = {
    zstd: (body) => promisify(zstdCompress)(body, { params: { [constants.ZSTD_c_compressionLevel]: 19 } }),
    br: (body) =>
        promisify(brotliCompress)(body, {
            params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: body.byteLength },
        }),
    gzip: (body) => promisify(gzip)(body, { level: 9 }),
} satisfies Record<Coding, (body: Buffer) => Promise<Buffer>>;

export const encodeOnce = async (coding: Coding, body: Buffer, level: "dynamic" | "static" = "dynamic"): Promise<Uint8Array<ArrayBuffer>> =>
    // Copied into a plain view: a Response takes an ArrayBuffer-backed body.
    new Uint8Array(await (level === "static" ? staticEncoders : dynamicEncoders)[coding](body));

// An encoder and the flush kind that makes everything written to it so far decodable.
export interface StreamEncoder {
    readonly encoder: Gzip | BrotliCompress | ZstdCompress;
    readonly flush: number;
}

// A streaming encoder at the dynamic level. The window
// is held to 1 MiB for zstd and brotli: a stream lives as long as its connection (an editor tab holds several), and a
// wider one costs memory per stream for under a point of ratio on the frames these streams carry.
export const streamEncoder = (coding: Coding): StreamEncoder => {
    switch (coding) {
        case "zstd":
            return {
                encoder: createZstdCompress({ params: { [constants.ZSTD_c_compressionLevel]: 3, [constants.ZSTD_c_windowLog]: 20 } }),
                flush: constants.ZSTD_e_flush,
            };
        case "br":
            return {
                encoder: createBrotliCompress({ params: { [constants.BROTLI_PARAM_QUALITY]: 4, [constants.BROTLI_PARAM_LGWIN]: 20 } }),
                flush: constants.BROTLI_OPERATION_FLUSH,
            };
        case "gzip":
            return { encoder: createGzip({ level: 6 }), flush: constants.Z_SYNC_FLUSH };
    }
};

/**
 * `source` encoded as it is read, each chunk flushed before the next is read: a frame an event stream writes reaches
 * the browser whole and at once, with the stream's earlier frames still in the encoder's window (a frame of an agent's
 * stream shrinks to a fifth, where encoding each alone would leave three quarters). The browser cancelling (a closed
 * tab) cancels `source`; `source` failing fails the encoded stream.
 */
export const encodeStream = (source: ReadableStream<Uint8Array>, coding: Coding): ReadableStream<Uint8Array> => {
    const { encoder, flush } = streamEncoder(coding);
    const reader = source.getReader();
    // The reader leaving destroys the encoder (Readable.toWeb's cancel); nothing is left to read the source for.
    encoder.once("close", () => {
        // allow(silent-catch): a source that already ended or failed has nothing left to cancel
        reader.cancel().catch(() => undefined);
    });
    const pump = async (): Promise<void> => {
        for (;;) {
            // one stream, read in order
            const { done, value } = await reader.read();
            if (done || encoder.destroyed) {
                break;
            }
            encoder.write(value);
            // The callback waits for the reader when the encoded side is full, which is the backpressure onto source.
            // one stream, flushed in order
            await new Promise<void>((resolve) => encoder.flush(flush, () => resolve()));
        }
        encoder.end();
    };
    pump().catch((error: Error) => encoder.destroy(error));
    return webStream(Readable.toWeb(encoder));
};
