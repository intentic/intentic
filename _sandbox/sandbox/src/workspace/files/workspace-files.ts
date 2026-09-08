import { createHash } from "node:crypto";
import { cp, mkdir, open, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

// Reads a workspace file's text whole; undefined when missing.
// For callers that already bound their read size (diff sides, untracked summaries, .intentic manifests); the browser
// route uses readWorkspaceFileWindow instead.
export const readWorkspaceFile = async (absPath: string): Promise<string | undefined> => {
    try {
        return await readFile(absPath, "utf8");
    } catch {
        return undefined;
    }
};

// Bounds a single text read/window so neither daemon nor browser holds an entire file as a string.
export const MAX_TEXT_BYTES = 4 * 1024 * 1024;

// A slice of a file's text plus its position: size is the whole file, offset/bytes the byte range this text decodes.
// Byte counts, not string length (they differ on non-ASCII); more remains when offset > 0 or offset + bytes < size.
export interface WorkspaceFileWindow {
    readonly content: string;
    readonly size: number;
    readonly offset: number;
    readonly bytes: number;
}

// A utf8 continuation byte (0b10xxxxxx): the middle of a character, never a cut point.
const isContinuation = (byte: number): boolean => (byte & 0b1100_0000) === 0b1000_0000;

// Bytes in a character from its lead byte: 4 for 0b11110xxx, 3 for 0b1110xxxx, 2 for 0b110xxxxx, else 1.
const sequenceLength = (byte: number): number => (byte >= 0b1111_0000 ? 4 : byte >= 0b1110_0000 ? 3 : byte >= 0b1100_0000 ? 2 : 1);

// Trims a byte window to a clean decode: no partial character or line at a non-file boundary (atStart/atEnd mark real
// file ends).
// A window with no newline (one long line) keeps its bytes; there's no line boundary to snap to.
const trimToBoundaries = (buffer: Buffer, atStart: boolean, atEnd: boolean): { start: number; end: number } => {
    let start = 0;
    let end = buffer.length;
    if (!atStart) {
        // Enter on a character boundary, then skip past the partial line the window opened in.
        while (start < end && isContinuation(buffer[start] ?? 0)) {
            start += 1;
        }
        const newline = buffer.indexOf(0x0a, start);
        if (newline !== -1) {
            start = newline + 1;
        }
    }
    if (!atEnd) {
        const newline = buffer.lastIndexOf(0x0a, end - 1);
        if (newline !== -1 && newline >= start) {
            return { start, end: newline + 1 };
        }
        // No line boundary to cut on; walk back to the cut character's lead byte and keep it only if it's whole.
        let lead = end - 1;
        while (lead > start && isContinuation(buffer[lead] ?? 0)) {
            lead -= 1;
        }
        if (end - lead < sequenceLength(buffer[lead] ?? 0)) {
            end = lead;
        }
    }
    return { start, end };
};

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
        // One byte before the window tells asked-mid-line from asked-at-line-start; excluded from the returned content.
        const probe = from > 0 ? 1 : 0;
        const buffer = Buffer.alloc(Math.min(window, size - from) + probe);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, from - probe);
        const slice = buffer.subarray(probe, bytesRead);
        const atStart = probe === 0 || buffer[0] === 0x0a;
        const { start, end } = trimToBoundaries(slice, atStart, from + slice.length >= size);
        return { content: slice.toString("utf8", start, end), size, offset: from + start, bytes: end - start };
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

// Reads raw bytes verbatim for binary previews via /workspace/raw, which the utf8 text read would corrupt; undefined
// when absent.
export const readWorkspaceFileBytes = async (absPath: string): Promise<Buffer | undefined> => {
    try {
        return await readFile(absPath);
    } catch {
        return undefined;
    }
};

// File size, used to refuse an oversized raw read before loading it; undefined when absent.
export const statWorkspaceFileSize = async (absPath: string): Promise<number | undefined> => {
    try {
        return (await stat(absPath)).size;
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
