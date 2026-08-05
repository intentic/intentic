import { mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { extract, type Headers } from "tar-stream";
import { isControlPlanePath, MAX_UPLOAD_BYTES, resolveWithin, setWorkspaceMtime, writeStreamCounted } from "./workspace-files.js";

// A tar entry whose path climbs out of /work — the route answers 400 (same as the single-file upload's escape
// guard), aborting the whole extraction rather than writing a partial tree outside the workspace.
export class PathEscapeError extends Error {
    constructor() {
        super("invalid path");
    }
}

// Fully consume (and discard) an entry's body, so tar-stream will emit the next entry. Used for directory markers
// and skipped duplicate/alias entries, which carry no bytes we keep.
const drain = (source: Readable): Promise<void> =>
    new Promise((resolve, reject) => {
        source.on("end", resolve);
        source.on("error", reject);
        source.resume();
    });

// True when `path` already exists AND is a directory (false when absent or a file). Detects a file entry that
// collides with an already-materialized directory — a symlink alias the browser packer can't filter out.
const isDirectory = async (path: string): Promise<boolean> => {
    try {
        return (await stat(path)).isDirectory();
    } catch {
        return false;
    }
};

// Stream a tar archive (a request body) into /work, materializing its tree entry-by-entry with the SAME guards as
// the single-file upload: an escaping path aborts with 400, and a single shared byte budget spans the whole
// archive (→ 413 via UploadTooLargeError). Nothing is buffered — each entry streams straight to disk — so a
// multi-GB drop stays flat.
export const extractTarToWorkspace = async (root: string, body: ReadableStream<Uint8Array>, limit = MAX_UPLOAD_BYTES): Promise<void> => {
    const ex = extract();
    let remaining = limit;

    const handleEntry = async (header: Headers, stream: Readable): Promise<void> => {
        const target = resolveWithin(root, header.name);
        if (target === undefined) {
            throw new PathEscapeError();
        }
        // The daemon's credential + auth state is not writable through the generic upload (see
        // isControlPlanePath). Skip the entry rather than abort the extraction: a drop that happens to carry one
        // must not cost the other ten thousand files.
        if (isControlPlanePath(root, target)) {
            await drain(stream);
            return;
        }
        if (header.type !== "file") {
            if (header.type === "directory") {
                await mkdir(target, { recursive: true });
            }
            await drain(stream);
            return;
        }
        // A file entry whose path already IS a directory in /work is a symlink-following alias Chrome duplicated
        // (the browser API can't flag symlinks — see intentic-app dropEntries.ts): the real subtree is already
        // materialized by the sibling entries, so skip this duplicate rather than let createWriteStream(EISDIR) →
        // non-recursive cleanup rm(ENOTEMPTY) abort the whole upload.
        if (await isDirectory(target)) {
            console.warn(`Skipping ${header.name}: a directory already exists there (symlink alias in the drop)`);
            await drain(stream);
            return;
        }
        // Mirror-image alias: a parent segment of this path is already a FILE. Recursive mkdir is idempotent for
        // existing dirs, so it only throws here on that collision — ENOTDIR when an ancestor segment is the file,
        // EEXIST when the immediate parent is. Skip the entry either way (tar entry order is non-deterministic, so
        // either collision direction can land).
        try {
            await mkdir(dirname(target), { recursive: true });
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code !== "ENOTDIR" && code !== "EEXIST") {
                throw error;
            }
            console.warn(`Skipping ${header.name}: a parent path is already a file (symlink alias in the drop)`);
            await drain(stream);
            return;
        }
        remaining -= await writeStreamCounted(stream, target, () => remaining);
        // Preserve the source mtime (the tar carries it) so a re-upload can skip this file by size+mtime.
        if (header.mtime !== undefined) {
            await setWorkspaceMtime(target, header.mtime.getTime());
        }
    };

    const source = Readable.fromWeb(body as NodeReadableStream<Uint8Array>);
    await new Promise<void>((resolve, reject) => {
        let settled = false;
        // Abort once: tear down both streams WITHOUT re-emitting the error (a destroy(err) would surface a second,
        // unhandled 'error' on the other end after we've already rejected), then reject with the real cause.
        const fail = (error: unknown): void => {
            if (settled) {
                return;
            }
            settled = true;
            source.destroy();
            ex.destroy();
            reject(error instanceof Error ? error : new Error(String(error)));
        };
        ex.on("entry", (header, stream, next) => {
            handleEntry(header, stream).then(() => next(), fail);
        });
        ex.on("finish", () => {
            if (!settled) {
                settled = true;
                resolve();
            }
        });
        ex.on("error", fail);
        source.on("error", fail);
        source.pipe(ex);
    });
};
