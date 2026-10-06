import { createHash } from "node:crypto";
import { cp, mkdir, open, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { openWorkspaceFileRange } from "./workspace-files-download.js";
import { errnoCode, isMissing } from "@intentic/base/errors";
import { decodeUtf16Window, UTF16_PROBE, utf16ByBom } from "@intentic/base/utf16-text";
import { isUtf8, trimUtf8Window } from "@intentic/base/utf8-text";
import type { WorkspaceFilePresentSchema } from "@intentic/sandbox-contract";
import type { z } from "zod";

// A workspace file's text whole, for callers that bound their own read size; undefined only when missing or a
// directory, and any other failure throws, so a read-modify-write never replaces content it could not read.
export const readWorkspaceFile = async (absPath: string): Promise<string | undefined> => {
    try {
        return await readFile(absPath, "utf8");
    } catch (error) {
        if (isMissing(error) || errnoCode(error) === "EISDIR") {
            return undefined;
        }
        throw error;
    }
};

// Bounds a single text read/window so neither daemon nor browser holds an entire file as a string.
export const MAX_TEXT_BYTES = 4 * 1024 * 1024;

// A slice of a file's text plus its position, the contract's window without the route's own fields (`present`, `path`,
// `shared`): size is the whole file, offset/bytes the byte range this text decodes. Byte counts, not string length (they
// differ on non-ASCII); more remains when offset > 0 or offset + bytes < size. `lossy` marks text that is not UTF-8 (a
// UTF-16 file behind its BOM, or bytes that do not decode as UTF-8), which the editor shows read-only, since a save
// would write UTF-8, with U+FFFD where bytes failed to decode.
export type WorkspaceFileWindow = Pick<z.infer<typeof WorkspaceFilePresentSchema>, "content" | "size" | "offset" | "bytes" | "lossy">;

// Reads a window of a workspace file's text; undefined when missing. Path is already contained by resolveWithin.
// A negative offset reads the file's tail (for following a growing log); limit is clamped to MAX_TEXT_BYTES regardless
// of caller.
export const readWorkspaceFileWindow = async (absPath: string, offset = 0, limit = MAX_TEXT_BYTES): Promise<WorkspaceFileWindow | undefined> => {
    let handle;
    try {
        handle = await open(absPath, "r");
        const { size } = await handle.stat();
        const window = Math.min(Math.max(limit, 0), MAX_TEXT_BYTES);
        const from = Math.min(offset < 0 ? Math.max(size + offset, 0) : offset, size);
        // UTF-16 behind a BOM (Windows' desktop.ini) is text, not the NUL-riddled binary a UTF-8 decode makes of it.
        const head = Buffer.alloc(2);
        await handle.read(head, 0, 2, 0);
        const utf16 = utf16ByBom(head);
        if (utf16 !== undefined) {
            const probe = Math.min(from, UTF16_PROBE);
            const buffer = Buffer.alloc(Math.min(window, size - from) + probe);
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, from - probe);
            return { ...decodeUtf16Window(buffer.subarray(0, bytesRead), probe, from, size, utf16), size, lossy: true };
        }
        // One byte before the window tells asked-mid-line from asked-at-line-start; excluded from the returned content.
        const probe = from > 0 ? 1 : 0;
        const buffer = Buffer.alloc(Math.min(window, size - from) + probe);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, from - probe);
        const slice = buffer.subarray(probe, bytesRead);
        const atStart = probe === 0 || buffer[0] === 0x0a;
        const { start, end } = trimUtf8Window(slice, atStart, from + slice.length >= size);
        const read = { content: slice.toString("utf8", start, end), size, offset: from + start, bytes: end - start };
        // Bytes that are not UTF-8 (Latin-1, Windows-1252) decode with U+FFFD in them, and a save would write those over
        // the file's own bytes: lossy, the desktop folder server's rule too, so the editor opens it read-only.
        return isUtf8(slice.subarray(start, end)) ? read : { ...read, lossy: true };
    } catch {
        return undefined;
    } finally {
        await handle?.close();
    }
};

// sha256 over the text's utf8 bytes, matching what the browser computes from the same decoded string.
export const sha256Text = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

// Writes a file's contents, creating parent dirs; accepts bytes or text so upload and editor save share one path.
export const writeWorkspaceFile = async (absPath: string, content: string | Uint8Array): Promise<void> => {
    await mkdir(dirname(absPath), { recursive: true });
    await writeFile(absPath, content);
};

// Creates a directory and any missing parents; idempotent when it already exists.
export const makeWorkspaceDir = async (absPath: string): Promise<void> => {
    await mkdir(absPath, { recursive: true });
};

// Deletes a file or directory recursively; a no-op when absent.
export const removeWorkspacePath = async (absPath: string): Promise<void> => {
    await rm(absPath, { recursive: true, force: true });
};

// Moves/renames a file or directory, creating the target's parent first.
export const moveWorkspacePath = async (fromAbs: string, toAbs: string): Promise<void> => {
    await mkdir(dirname(toAbs), { recursive: true });
    await rename(fromAbs, toAbs);
};

// Copies a file or directory recursively, creating the target's parent first.
export const copyWorkspacePath = async (fromAbs: string, toAbs: string): Promise<void> => {
    await mkdir(dirname(toAbs), { recursive: true });
    await cp(fromAbs, toAbs, { recursive: true });
};

// File size, used to refuse an oversized raw read before loading it; undefined when absent.
export const statWorkspaceFileSize = async (absPath: string): Promise<number | undefined> => {
    try {
        return (await stat(absPath)).size;
    } catch {
        return undefined;
    }
};

// A file opened for streaming: its size, a validator that moves whenever its bytes may have (a replacing rename moves the
// inode, a write the size or mtime), and its bytes, opened only when asked for; undefined when absent or not a file.
export interface OpenedWorkspaceFile {
    readonly size: number;
    readonly tag: string;
    readonly body: () => ReadableStream<Uint8Array>;
}

export const openWorkspaceFile = async (absPath: string): Promise<OpenedWorkspaceFile | undefined> => {
    try {
        const stats = await stat(absPath);
        if (!stats.isFile()) {
            return undefined;
        }
        const tag = `W/"${[stats.ino, stats.size, Math.round(stats.mtimeMs * 1000)].map((part) => part.toString(36)).join("-")}"`;
        return {
            size: stats.size,
            tag,
            body: () => (stats.size === 0 ? new Blob([]).stream() : openWorkspaceFileRange(absPath, 0, stats.size - 1)),
        };
    } catch {
        return undefined;
    }
};

// Size and mtime together, undefined when absent; backs the re-upload diff that skips an unchanged dropped file.
export const statWorkspaceSizeMtime = async (absPath: string): Promise<{ size: number; mtimeMs: number } | undefined> => {
    try {
        const s = await stat(absPath);
        return { size: s.size, mtimeMs: s.mtimeMs };
    } catch {
        return undefined;
    }
};

// Stamps a written file with the source's mtime so a later re-upload can skip it by size+mtime.
// Best-effort: a utimes failure must never fail the upload.
export const setWorkspaceMtime = async (absPath: string, mtimeMs: number): Promise<void> => {
    const when = new Date(mtimeMs);
    await utimes(absPath, when, when).catch(() => {});
};
