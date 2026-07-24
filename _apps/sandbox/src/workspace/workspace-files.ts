import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { cp, mkdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
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
// request — capabilities.json carries the capability manifest's secrets, and claude/ codex/ kimi/ opencode/ hold
// the agent providers' tokens (AGENT_AUTH_DIR moves that set out of /work entirely, and then none of this is
// reachable to begin with).
const CONTROL_PLANE_ENTRIES = new Set(["owner.json", "members.json", "capabilities.json", "claude.json", "claude", "codex", "kimi", "opencode"]);

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
export const isControlPlanePath = (root: string, absPath: string): boolean => {
    const segments = relative(resolve(root), absPath).split(sep);
    return segments.length >= 2 && segments[0] === ".intentic" && CONTROL_PLANE_ENTRIES.has(segments[1] ?? "");
};

// Read a workspace file's text; undefined when it does not exist (the daemon maps that to 404). The path is
// already repo-contained by resolveWithin at the call site.
export const readWorkspaceFile = async (absPath: string): Promise<string | undefined> => {
    try {
        return await readFile(absPath, "utf8");
    } catch {
        return undefined;
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

// Best-effort Content-Type for the raw route, by extension — enough for the formats the viewer previews (images,
// PDF, audio); everything else is generic binary (the browser offers a download). No mime dependency on purpose.
// Audio needs a real type so the browser's <audio> element accepts the blob (an octet-stream blob can refuse to play).
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
    flac: "audio/flac",
    m4a: "audio/mp4",
    aac: "audio/aac",
};
export const contentTypeForPath = (absPath: string): string => MIME_BY_EXT[extname(absPath).slice(1).toLowerCase()] ?? "application/octet-stream";
