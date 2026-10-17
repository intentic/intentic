import { Readable, pipeline } from "node:stream";
import { createBrotliDecompress, createGunzip, createZstdDecompress, type BrotliDecompress, type Gunzip, type ZstdDecompress } from "node:zlib";
import { nodeStream, webStream } from "@intentic/base/web-stream";

// An upload sent encoded (RFC 7694 `Content-Encoding` on a request), decoded as it arrives. The browser's uplink is
// usually the narrowest part of the trip, and a dropped tree of source is text that gzip shrinks three- to fivefold, so
// the editor gzips what compresses before sending it. Only for a daemon that says it decodes: an older one would write
// the encoded bytes to disk as they came, so the codings are advertised on the /events hello and the editor sends
// plain bytes to any daemon that does not name them. Whatever cap a route holds an upload to counts the decoded bytes
// as they reach disk, so a small body that inflates past it is refused like any other.

const decoders = {
    gzip: createGunzip,
    "x-gzip": createGunzip,
    zstd: createZstdDecompress,
    br: createBrotliDecompress,
} satisfies Record<string, () => Gunzip | ZstdDecompress | BrotliDecompress>;

// What the hello advertises: the codings a browser may send an upload in. `x-gzip` is gzip's old name, accepted only.
export const UPLOAD_ENCODINGS = ["gzip", "zstd", "br"] as const;

const isDecodable = (coding: string): coding is keyof typeof decoders => Object.hasOwn(decoders, coding);

export type DecodedBody = { readonly body: ReadableStream<Uint8Array> | null } | { readonly unsupported: string };

/**
 * The request body as the route should read it: `body` itself when it was sent plain, decoded as it streams when it
 * was sent in a coding the daemon decodes, and `unsupported` (a 415 for the caller) for any other coding, a list of
 * several included. A body that fails to decode fails the stream its reader is reading.
 */
export const decodedBody = (body: ReadableStream<Uint8Array> | null, contentEncoding: string | undefined): DecodedBody => {
    const coding = (contentEncoding ?? "").trim().toLowerCase();
    if (coding === "" || coding === "identity" || body === null) {
        return { body };
    }
    if (!isDecodable(coding)) {
        return { unsupported: coding };
    }
    const decoder = decoders[coding]();
    // pipeline, not pipe: a failure on either side destroys both, and the decoder's error reaches the reader.
    pipeline(Readable.fromWeb(nodeStream(body)), decoder, () => undefined);
    return { body: webStream(Readable.toWeb(decoder)) };
};
