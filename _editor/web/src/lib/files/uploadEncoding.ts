import { isPackedName } from "@intentic/sandbox-contract/text/packed-formats";

// Whether a chunk of an upload crosses gzipped, pure and framework-free. Measured on the daemon's own payloads, gzip
// leaves a source tree, logs or JSON at a quarter to a third of its size, while the browser encodes it at tens of MB/s
// and gains nothing on images, media and archives. So: never to a daemon that does not decode it, never over this
// computer's own loopback (the link is faster than the encoder), never for a chunk too small to matter, and only when
// at least a third of the chunk's bytes are not already compressed, which is where the wire time saved outruns the
// encode on any uplink under about 100 Mbit/s.

const MIN_ENCODED_BYTES = 64 * 1024;
const MIN_TEXT_SHARE = 1 / 3;

export interface UploadLink {
    // The daemon's hello names gzip among the codings it decodes an upload from.
    readonly decodes: boolean;
    // The sandbox is reached over the loopback shortcut, on this computer or beside it.
    readonly local: boolean;
}

export const uploadEncoding = (files: readonly { readonly path: string; readonly size: number }[], link: UploadLink): `gzip` | undefined => {
    if (!link.decodes || link.local || !(`CompressionStream` in globalThis)) {
        return undefined;
    }
    let total = 0;
    let text = 0;
    for (const file of files) {
        total += file.size;
        text += isPackedName(file.path) ? 0 : file.size;
    }
    return total >= MIN_ENCODED_BYTES && text >= total * MIN_TEXT_SHARE ? `gzip` : undefined;
};

// Where a part starts in the body, how the request's progress (the bytes that cross) scales back onto the body's own,
// and the coding it crosses in.
export interface SentPart {
    readonly offset: number;
    readonly scale: number;
    readonly encoding: `gzip` | undefined;
}

/**
 * The part of `body` at `offset` as it is sent: as it is, or gzipped by CompressionStream, which encodes in the
 * browser's native zlib a chunk at a time, so the page keeps drawing in between.
 */
export const encodedPart = async (
    body: Blob,
    offset: number,
    partBytes: number,
    encoding: `gzip` | undefined,
): Promise<{ readonly part: Blob; readonly sent: SentPart }> => {
    const plain = body.slice(offset, offset + partBytes);
    if (encoding === undefined) {
        return { part: plain, sent: { offset, scale: 1, encoding } };
    }
    const part = await new Response(plain.stream().pipeThrough(new CompressionStream(`gzip`))).blob();
    return { part, sent: { offset, scale: part.size === 0 ? 1 : plain.size / part.size, encoding } };
};
