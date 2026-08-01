import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { cp, mkdir, open, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { dirname, extname, relative, resolve, sep } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

// Resolve a repo-relative path to an absolute one, guarding against escaping the repo dir: the daemon serves
// file reads/writes for the workspace repos, so a `../` or absolute path must not reach outside them. Returns
// undefined for the dir itself or any path that climbs out (the daemon answers 400 rather than touching it).
export const resolveWithin = (dir: string, relPath: string): string | undefined => {
    const base = resolve(dir);
    const target = resolve(base, relPath);
    const rel = relative(base, target);
    if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`)) {
        return undefined;
    }
    return target;
};

// The daemon's own credential and authorization state, all of it directly under the WORKSPACE ROOT's .intentic/.
// owner.json and members.json ARE the answer to "who may drive this sandbox" — re-read from disk on every
// request — capabilities.json carries the capability manifest's secrets, ci.json the CI webhook secret, and
// claude/ codex/ opencode/ and cliproxy/ hold agent-provider tokens (AGENT_AUTH_DIR moves that set out of /work
// entirely, and then none of this is reachable to begin with). `kimi` remains protected because sandboxes made
// before Kimi Code moved into cliproxy may still contain an inert API key there; generic file access must never
// turn a retired credential path into a readable one.
const CONTROL_PLANE_ENTRIES = new Set([
    "owner.json",
    "members.json",
    "capabilities.json",
    "ci.json",
    "claude.json",
    "claude",
    "codex",
    "kimi",
    "opencode",
    "cliproxy",
]);

// Whether an absolute path lands in that control plane. Every one of those files has a purpose-built, owner-gated
// route, so the GENERIC file API must not tunnel around them: a member — someone the owner invited to
// collaborate — could otherwise upload their own owner.json and take the sandbox, or read the owner's provider
// token straight back out of the raw route. Denied for everyone, the owner included: no flow needs to reach a
// token through the file API, and a rule with no role in it cannot be got wrong at a call site.
//
// Scoped deliberately tight. Only the ROOT .intentic is the control plane — a repo's own nested .intentic is
// ordinary workspace content — and only these entries within it, because the root's other subtrees are real
// features the browser drives through this same API (chat attachments under attachments/, a directory's own UI
// under ui/). A new credential store added under .intentic/ belongs in the set above.
//
// The ROOT's own .git joins them, subtree included. It is the --separate-git-dir pointer to /history/gits/root —
// the handle to the shadow history repo, which lives off /work precisely so the agent can't tamper with it (see
// git/root-repo.ts). It is also a FILE where a client that drops a repo's CONTENTS at the root tries to write a
// directory: without this floor, writeWorkspaceFileStream's mkdir throws ENOTDIR/EEXIST per entry and the upload
// route 500s the whole drop instead of skipping the handful of paths that were never writable to begin with.
// A NESTED repo's .git is ordinary content — a dropped repo keeps its own and stays connected to its remote.
export const isControlPlanePath = (root: string, absPath: string): boolean => {
    const segments = relative(resolve(root), absPath).split(sep);
    if (segments[0] === ".git") {
        return true;
    }
    return segments.length >= 2 && segments[0] === ".intentic" && CONTROL_PLANE_ENTRIES.has(segments[1] ?? "");
};

/* Read a workspace file's text WHOLE; undefined when it does not exist. For the daemon's own readers, which
 * have already bounded what they ask for: a diff side (512 KiB cap, changes.ts), an untracked file's commit
 * summary (MAX_UNTRACKED_BYTES), and the small .intentic manifests. The browser's file route does NOT come
 * through here — see readWorkspaceFileWindow for why an unbounded read has no place on an HTTP route. */
export const readWorkspaceFile = async (absPath: string): Promise<string | undefined> => {
    try {
        return await readFile(absPath, "utf8");
    } catch {
        return undefined;
    }
};

/* Hard cap on ONE text read's window. The whole point of reading a window rather than the file is that neither
 * side has to hold a log: `readFile(abs, "utf8")` allocated the entire file as a string, JSON-serialized a
 * second copy of it, and blocked the daemon's only event loop for both — ~370ms and 455MB of RSS for a 120MB
 * log, with every SSE stream, terminal and agent on that loop waiting. Past ~512MB it didn't even fail
 * honestly: V8 threw "Invalid string length", which the old catch turned into `undefined` → 404 → the browser
 * closed the tab as if the file had been deleted. A window costs the window. */
export const MAX_TEXT_BYTES = 4 * 1024 * 1024;

// A slice of a file's text plus what it is a slice OF, so the reader knows where it stands without a second
// call: `size` is the whole file, `offset`/`bytes` the byte range this text decodes from (offset > 0 or
// offset + bytes < size ⇒ there is more). Byte counts, not string length — they differ on non-ASCII, and the
// next window's offset has to be a byte offset.
export interface WorkspaceFileWindow {
    readonly content: string;
    readonly size: number;
    readonly offset: number;
    readonly bytes: number;
}

// A utf8 continuation byte (0b10xxxxxx) — the middle of a character, never a place to cut.
const isContinuation = (byte: number): boolean => (byte & 0b1100_0000) === 0b1000_0000;

// How many bytes the character starting with this byte occupies: 0b11110xxx begins four, 0b1110xxxx three,
// 0b110xxxxx two, and anything else is a single (ASCII) byte.
const sequenceLength = (byte: number): number => (byte >= 0b1111_0000 ? 4 : byte >= 0b1110_0000 ? 3 : byte >= 0b1100_0000 ? 2 : 1);

/* Trim a byte window so it decodes cleanly: no partial character at either end (a window boundary lands
 * wherever the byte count fell, which for any multi-byte character is mid-sequence), and no partial LINE
 * either — a viewer that starts mid-line reads as corrupt, and appending the next window would double the
 * seam. `atStart`/`atEnd` mark the ends of the FILE, which are real boundaries and must not be trimmed.
 *
 * A window that holds no newline at all (one very long line — minified JS, a single-line JSON log) keeps its
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
 * `offset` is where the caller wants to read from — a negative one reads the file's TAIL, which is what
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
         * and trimming the second case drops a whole line — so paging through a log would skip one line per
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
// DECODED text (not raw file bytes) matches what the browser can compute — it only ever saw the utf8-decoded
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

// The browser previews binary files (images, PDFs) by fetching their raw bytes from /workspace/raw — the text
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
// write-time mtime (e.g. the editor's text save). Best-effort — a utimes failure must never fail the upload.
export const setWorkspaceMtime = async (absPath: string, mtimeMs: number): Promise<void> => {
    const when = new Date(mtimeMs);
    await utimes(absPath, when, when).catch(() => {});
};

// Hard cap on a single raw read — the browser holds the whole response as a Blob, so keep it bounded (→ 413).
export const MAX_RAW_BYTES = 25 * 1024 * 1024;

// Uploads stream straight to disk (never fully buffered), so the ceiling is only there to stop a single file or
// archive from filling the sandbox disk — hence far higher than the read cap.
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
        // offset > 0 = a later part of a split upload: write in place ("r+" — part 0 created the file).
        await pipeline(source, counter, createWriteStream(absPath, offset > 0 ? { flags: "r+", start: offset } : {}));
    } catch (error) {
        // A failed later part keeps the file — the client's retry re-sends from part 0 and rewrites it.
        if (offset === 0) {
            await rm(absPath, { force: true });
        }
        throw error;
    }
    return written;
};

// Best-effort Content-Type for the raw + media routes, by extension — enough for the formats the viewer
// previews (images, PDF, audio, video); everything else is generic binary (the browser offers a download). No
// mime dependency on purpose. A real type MATTERS for the timed media: an <audio>/<video> handed
// application/octet-stream refuses to decode it, whatever the bytes actually are.
const MIME_BY_EXT: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    avif: "image/avif",
    svg: "image/svg+xml",
    bmp: "image/bmp",
    ico: "image/x-icon",
    pdf: "application/pdf",
    mp3: "audio/mpeg",
    wav: "audio/wav",
    ogg: "audio/ogg",
    oga: "audio/ogg",
    opus: "audio/ogg",
    weba: "audio/webm",
    flac: "audio/flac",
    m4a: "audio/mp4",
    aac: "audio/aac",
    // Video. The last three are containers no browser decodes natively; they are typed honestly anyway so the
    // player can say "this format won't play here" from the element's own error instead of guessing.
    mp4: "video/mp4",
    m4v: "video/mp4",
    webm: "video/webm",
    ogv: "video/ogg",
    mov: "video/quicktime",
    "3gp": "video/3gpp",
    mkv: "video/x-matroska",
    avi: "video/x-msvideo",
    wmv: "video/x-ms-wmv",
};
export const contentTypeForPath = (absPath: string): string => MIME_BY_EXT[extname(absPath).slice(1).toLowerCase()] ?? "application/octet-stream";

/* THE BYTE WINDOW A MEDIA ELEMENT ASKS FOR — the parsed form of a `Range: bytes=…` header against a file of
 * `size` bytes, or the whole file when there is no header. `unsatisfiable` is its own answer (→ 416) rather
 * than a clamp, because a player that asks past the end has lost track of the file and should be told.
 *
 * Only the single-range form is honoured. Multi-range (`bytes=0-99,200-299`) would have to answer
 * multipart/byteranges, which no media element ever asks for — those are read sequentially, one window at a
 * time — so an exotic multi-range request is served the whole file instead, which is always a legal answer. */
export interface ByteRange {
    readonly start: number;
    readonly end: number; // inclusive, the way Content-Range counts
    readonly partial: boolean;
}

export const parseByteRange = (header: string | undefined, size: number): ByteRange | "unsatisfiable" => {
    const whole = { start: 0, end: Math.max(size - 1, 0), partial: false } as const;
    const match = header === undefined ? null : /^bytes=(\d*)-(\d*)$/.exec(header.trim());
    if (match === null) {
        return whole;
    }
    const [, from, to] = match;
    // A suffix range ("bytes=-500") is the LAST n bytes — how a player reads a trailing index (an MP4 whose
    // moov atom was written last, and therefore every un-faststart-ed recording).
    if (from === "" || from === undefined) {
        const length = Number(to);
        if (to === "" || to === undefined || !Number.isFinite(length) || length <= 0) {
            return "unsatisfiable";
        }
        return { start: Math.max(size - length, 0), end: size - 1, partial: true };
    }
    const start = Number(from);
    if (!Number.isFinite(start) || start >= size) {
        return "unsatisfiable";
    }
    const end = to === "" || to === undefined ? size - 1 : Math.min(Number(to), size - 1);
    if (!Number.isFinite(end) || end < start) {
        return "unsatisfiable";
    }
    return { start, end, partial: true };
};

// A file's bytes as a web ReadableStream, from `start` to `end` inclusive — the media route's body. Streamed
// off disk rather than read into a Buffer, which is the whole reason /workspace/media exists beside
// /workspace/raw: a 2 GB recording costs one 64 KiB chunk of daemon memory at a time, not 2 GB.
export const openWorkspaceFileRange = (absPath: string, start: number, end: number): ReadableStream<Uint8Array> => {
    return Readable.toWeb(createReadStream(absPath, { start, end })) as ReadableStream<Uint8Array>;
};
