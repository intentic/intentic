import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

// Only bounds a single upload/archive against filling disk; higher than MAX_RAW_BYTES since nothing buffers.
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024 * 1024;

// Thrown by the streaming writers past the byte limit; routes map it to 413.
export class UploadTooLargeError extends Error {
    constructor() {
        super("file too large");
    }
}

// Streams a request body straight to disk, creating parent dirs and aborting (deleting the partial file) past `limit`.
// Never buffers in full; the archive route reuses this via writeStreamCounted for its own counting and cleanup.
export const writeWorkspaceFileStream = async (absPath: string, body: ReadableStream<Uint8Array>, limit: number, offset = 0): Promise<void> => {
    await mkdir(dirname(absPath), { recursive: true });
    await writeStreamCounted(Readable.fromWeb(body as NodeReadableStream<Uint8Array>), absPath, () => limit - offset, offset);
};

// Pipes a Node readable to absPath, throwing UploadTooLargeError and removing the partial file once written bytes pass
// remaining().
// The archive extractor passes a shrinking budget so the cap spans the whole tar, not each entry.
export const writeStreamCounted = async (source: Readable, absPath: string, remaining: () => number, offset = 0): Promise<number> => {
    let written = 0;
    const counter = new Transform({
        transform(chunk: Buffer, _enc, cb) {
            written += chunk.byteLength;
            if (written > remaining()) {
                cb(new UploadTooLargeError());
                return;
            }
            cb(undefined, chunk);
        },
    });
    try {
        // offset > 0 is a later part of a split upload; writes in place since part 0 already created the file.
        await pipeline(source, counter, createWriteStream(absPath, offset > 0 ? { flags: "r+", start: offset } : {}));
    } catch (error) {
        // A failed later part keeps the file; a retry resends from part 0 and overwrites it.
        if (offset === 0) {
            await rm(absPath, { force: true });
        }
        throw error;
    }
    return written;
};
