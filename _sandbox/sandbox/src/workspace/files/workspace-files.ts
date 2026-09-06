import { createHash } from "node:crypto";
import { cp, mkdir, open, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/* Read a workspace file's text WHOLE; undefined when it does not exist. For the daemon's own readers, which
 * have already bounded what they ask for: a diff side (512 KiB cap, changes.ts), an untracked file's commit
 * summary (MAX_UNTRACKED_BYTES), and the small .intentic manifests. The browser's file route does NOT come
 * through here, see readWorkspaceFileWindow for why an unbounded read has no place on an HTTP route. */
export const readWorkspaceFile = async (absPath: string): Promise<string | undefined> => {
    try {
        return await readFile(absPath, "utf8");
    } catch {
        return undefined;
    }
};

/* Hard cap on ONE text read's window. The whole point of reading a window rather than the file is that neither
 * side has to hold a log: `readFile(abs, "utf8")` allocated the entire file as a string, JSON-serialized a
 * second copy of it, and blocked the daemon's only event loop for both: ~370ms and 455MB of RSS for a 120MB
 * log, with every SSE stream, terminal and agent on that loop waiting. Past ~512MB it didn't even fail
 * honestly: V8 threw "Invalid string length", which the old catch turned into `undefined` → 404 → the browser
 * closed the tab as if the file had been deleted. A window costs the window. */
export const MAX_TEXT_BYTES = 4 * 1024 * 1024;

// A slice of a file's text plus what it is a slice OF, so the reader knows where it stands without a second
// call: `size` is the whole file, `offset`/`bytes` the byte range this text decodes from (offset > 0 or
// offset + bytes < size ⇒ there is more). Byte counts, not string length, they differ on non-ASCII, and the
// next window's offset has to be a byte offset.
export interface WorkspaceFileWindow {
    readonly content: string;
    readonly size: number;
    readonly offset: number;
    readonly bytes: number;
}

// A utf8 continuation byte (0b10xxxxxx), the middle of a character, never a place to cut.
const isContinuation = (byte: number): boolean => (byte & 0b1100_0000) === 0b1000_0000;

// How many bytes the character starting with this byte occupies: 0b11110xxx begins four, 0b1110xxxx three,
// 0b110xxxxx two, and anything else is a single (ASCII) byte.
const sequenceLength = (byte: number): number => (byte >= 0b1111_0000 ? 4 : byte >= 0b1110_0000 ? 3 : byte >= 0b1100_0000 ? 2 : 1);

/* Trim a byte window so it decodes cleanly: no partial character at either end (a window boundary lands
 * wherever the byte count fell, which for any multi-byte character is mid-sequence), and no partial LINE
 * either, a viewer that starts mid-line reads as corrupt, and appending the next window would double the
 * seam. `atStart`/`atEnd` mark the ends of the FILE, which are real boundaries and must not be trimmed.
 *
 * A window that holds no newline at all (one very long line, minified JS, a single-line JSON log) keeps its
 * bytes: there is no line boundary to snap to, and dropping the window would show nothing at all. */
const trimToBoundaries = (buffer: Buffer, atStart: boolean, atEnd: boolean): { start: number; end: number } => {
    let start = 0;
    let end = buffer.length;
    if (!atStart) {
        // Enter on a character boundary first, then move past the partial line the window opened in.
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
        // No line boundary to cut on (one very long line): drop only a character the window cut in half. Walk
        // back to the last sequence's LEAD byte, and keep that sequence only if all of it is here.
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

/* Read a window of a workspace file's text; undefined when it does not exist (the daemon maps that to 404).
 * The path is already repo-contained by resolveWithin at the call site.
 *
 * `offset` is where the caller wants to read from, a negative one reads the file's TAIL, which is what
 * following a growing log means (the offset a tail wants isn't knowable until the size is, and by the time a
 * caller has stat'd the file the log has grown again). `limit` is clamped to MAX_TEXT_BYTES: the cap belongs
 * to the daemon, not to whoever asks. */
export const readWorkspaceFileWindow = async (absPath: string, offset = 0, limit = MAX_TEXT_BYTES): Promise<WorkspaceFileWindow | undefined> => {
    let handle;
    try {
        handle = await open(absPath, "r");
        const { size } = await handle.stat();
        const window = Math.min(Math.max(limit, 0), MAX_TEXT_BYTES);
        const from = Math.min(offset < 0 ? Math.max(size + offset, 0) : offset, size);
        /* Read one byte BEFORE the window when there is one, purely to see what precedes it. Without that byte
         * there is no way to tell "the caller asked mid-line" from "the caller asked exactly at a line start",
         * and trimming the second case drops a whole line, so paging through a log would skip one line per
         * window, silently. The probe is not part of the content. */
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

// The content hash the editor's guarded save compares against: sha256 over the text's utf8 bytes. Hashing the
// DECODED text (not raw file bytes) matches what the browser can compute, it only ever saw the utf8-decoded
// string from /workspace/file, so both sides hash the same shape by construction.
export const sha256Text = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

// Write a file's contents, auto-creating parent dirs. Accepts bytes too, so the drag-drop upload route and the
// editor's text save share one write path (uploaded bytes / edited utf8 text are both just a body to persist).
export const writeWorkspaceFile = async (absPath: string, content: string | Uint8Array): Promise<void> => {
    await mkdir(dirname(absPath), { recursive: true });
    await writeFile(absPath, content);
};

// Create a directory (and any missing parents); idempotent when it already exists. Backs the "new folder" op.
export const makeWorkspaceDir = async (absPath: string): Promise<void> => {
    await mkdir(absPath, { recursive: true });
};

// Delete a file or directory (recursively); a no-op when absent. Backs delete + the move-away half of a rename.
export const removeWorkspacePath = async (absPath: string): Promise<void> => {
    await rm(absPath, { recursive: true, force: true });
};

// Move/rename a file or directory, creating the target's parent first. Backs rename, move, and cut→paste.
export const moveWorkspacePath = async (fromAbs: string, toAbs: string): Promise<void> => {
    await mkdir(dirname(toAbs), { recursive: true });
    await rename(fromAbs, toAbs);
};

// Copy a file or directory (recursively), creating the target's parent first. Backs copy→paste.
export const copyWorkspacePath = async (fromAbs: string, toAbs: string): Promise<void> => {
    await mkdir(dirname(toAbs), { recursive: true });
    await cp(fromAbs, toAbs, { recursive: true });
};

// The browser previews binary files (images, PDFs) by fetching their raw bytes from /workspace/raw, the text
// read above utf8-decodes and would corrupt them. Read the bytes verbatim; undefined when absent (→ 404).
export const readWorkspaceFileBytes = async (absPath: string): Promise<Buffer | undefined> => {
    try {
        return await readFile(absPath);
    } catch {
        return undefined;
    }
};

// The file's size, used to refuse an oversized raw read BEFORE loading it into memory; undefined when absent.
export const statWorkspaceFileSize = async (absPath: string): Promise<number | undefined> => {
    try {
        return (await stat(absPath)).size;
    } catch {
        return undefined;
    }
};

// Size + mtime together; undefined when absent. Backs the re-upload diff (/workspace/upload-diff): the client's
// dropped-file size + mtime are matched against these so an unchanged file is skipped instead of re-sent.
export const statWorkspaceSizeMtime = async (absPath: string): Promise<{ size: number; mtimeMs: number } | undefined> => {
    try {
        const s = await stat(absPath);
        return { size: s.size, mtimeMs: s.mtimeMs };
    } catch {
        return undefined;
    }
};

// Stamp a written file with the SOURCE file's mtime (ms), so a later re-upload can skip it by size+mtime. The tar
// carries the source mtime and the single-file route passes it as ?mtime; a file written without one keeps its
// write-time mtime (e.g. the editor's text save). Best-effort, a utimes failure must never fail the upload.
export const setWorkspaceMtime = async (absPath: string, mtimeMs: number): Promise<void> => {
    const when = new Date(mtimeMs);
    await utimes(absPath, when, when).catch(() => {});
};
