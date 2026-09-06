import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

// Uploads stream straight to disk (never fully buffered), so the ceiling is only there to stop a single file or
// archive from filling the sandbox disk, hence far higher than the raw read cap (MAX_RAW_BYTES, workspace-files-download.ts).
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024 * 1024;

// Thrown by the streaming writers when the body exceeds the byte limit; the routes map it to a 413.
export class UploadTooLargeError extends Error {
    constructor() {
        super("file too large");
    }
}

// Stream a web ReadableStream (a request body) straight to disk, auto-creating parent dirs and aborting past
// `limit` (deleting the partial file). No full-buffer in memory, so it handles multi-GB uploads. The drag-drop
// upload route posts here; the archive route reuses the same counting+cleanup via `writeStreamCounted`.
export const writeWorkspaceFileStream = async (absPath: string, body: ReadableStream<Uint8Array>, limit: number, offset = 0): Promise<void> => {
    await mkdir(dirname(absPath), { recursive: true });
    await writeStreamCounted(Readable.fromWeb(body as NodeReadableStream<Uint8Array>), absPath, () => limit - offset, offset);
};

// Pipe a Node readable to `absPath`, throwing UploadTooLargeError (and removing the partial) once the running
// byte count passes the ceiling `remaining()` returns. The archive extractor passes a shrinking budget so the
// cap spans the whole tar, not each entry.
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
        // offset > 0 = a later part of a split upload: write in place ("r+", part 0 created the file).
        await pipeline(source, counter, createWriteStream(absPath, offset > 0 ? { flags: "r+", start: offset } : {}));
    } catch (error) {
        // A failed later part keeps the file, the client's retry re-sends from part 0 and rewrites it.
        if (offset === 0) {
            await rm(absPath, { force: true });
        }
        throw error;
    }
    return written;
};
