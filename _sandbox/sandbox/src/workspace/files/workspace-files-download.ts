import { createReadStream } from "node:fs";
import { extname } from "node:path";
import { Readable } from "node:stream";

// Hard cap on a single raw read, the browser holds the whole response as a Blob, so keep it bounded (→ 413).
export const MAX_RAW_BYTES = 25 * 1024 * 1024;

// Best-effort Content-Type for the raw + media routes, by extension, enough for the formats the viewer
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

/* THE BYTE WINDOW A MEDIA ELEMENT ASKS FOR, the parsed form of a `Range: bytes=…` header against a file of
 * `size` bytes, or the whole file when there is no header. `unsatisfiable` is its own answer (→ 416) rather
 * than a clamp, because a player that asks past the end has lost track of the file and should be told.
 *
 * Only the single-range form is honoured. Multi-range (`bytes=0-99,200-299`) would have to answer
 * multipart/byteranges, which no media element ever asks for, those are read sequentially, one window at a
 * time, so an exotic multi-range request is served the whole file instead, which is always a legal answer. */
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
    // A suffix range ("bytes=-500") is the LAST n bytes, how a player reads a trailing index (an MP4 whose
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

// A file's bytes as a web ReadableStream, from `start` to `end` inclusive, the media route's body. Streamed
// off disk rather than read into a Buffer, which is the whole reason /workspace/media exists beside
// /workspace/raw: a 2 GB recording costs one 64 KiB chunk of daemon memory at a time, not 2 GB.
export const openWorkspaceFileRange = (absPath: string, start: number, end: number): ReadableStream<Uint8Array> => {
    return Readable.toWeb(createReadStream(absPath, { start, end })) as ReadableStream<Uint8Array>;
};
