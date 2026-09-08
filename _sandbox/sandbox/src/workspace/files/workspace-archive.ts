import { mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { extract, type Headers } from "tar-stream";
import { drain, extractAll } from "../../tar-extract.js";
import { isControlPlanePath, resolveWithin } from "./workspace-files-paths.js";
import { MAX_UPLOAD_BYTES, writeStreamCounted } from "./workspace-files-upload.js";
import { setWorkspaceMtime } from "./workspace-files.js";

// A tar entry whose path escapes /work aborts the whole extraction with 400.
export class PathEscapeError extends Error {
    constructor() {
        super("invalid path");
    }
}


// True when path exists and is a directory, false otherwise.
const isDirectory = async (path: string): Promise<boolean> => {
    try {
        return (await stat(path)).isDirectory();
    } catch {
        return false;
    }
};

// Streams a tar archive into /work under the same escape and byte-budget guards as single-file upload.
export const extractTarToWorkspace = async (root: string, body: ReadableStream<Uint8Array>, limit = MAX_UPLOAD_BYTES): Promise<void> => {
    const ex = extract();
    let remaining = limit;

    const handleEntry = async (header: Headers, stream: Readable): Promise<void> => {
        const target = resolveWithin(root, header.name);
        if (target === undefined) {
            throw new PathEscapeError();
        }
        // Skips writes into the daemon's private state instead of aborting the whole extraction.
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
        // A file entry whose path is already a directory is a symlink alias; skip it, don't fail the upload.
        if (await isDirectory(target)) {
            console.warn(`Skipping ${header.name}: a directory already exists there (symlink alias in the drop)`);
            await drain(stream);
            return;
        }
        // Skips the entry when a parent segment is already a file (ENOTDIR) or the parent itself is (EEXIST).
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
        // Preserves the entry's mtime; re-upload skip-by-size+mtime depends on it.
        if (header.mtime !== undefined) {
            await setWorkspaceMtime(target, header.mtime.getTime());
        }
    };

    const source = Readable.fromWeb(body as NodeReadableStream<Uint8Array>);
    // Decoder errors surface unchanged; a workspace upload promises no particular archive format.
    await extractAll(source, ex, handleEntry);
};
