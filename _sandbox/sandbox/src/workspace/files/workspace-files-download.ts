import { createReadStream } from "node:fs";
import { extname } from "node:path";
import { Readable } from "node:stream";

// Hard cap on a raw read; the browser holds the whole response as a Blob.
export const MAX_RAW_BYTES = 25 * 1024 * 1024;

// Content-Type by extension for raw/media; audio/video need a real type or the element refuses to decode.
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
    // Last three are containers no browser decodes natively; typed anyway so the player reports its own error.
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

// Parsed form of a `Range: bytes=…` header (whole file when absent); `unsatisfiable` means out of range, not clamped.
// Only single-range is honored; a multi-range request gets the whole file instead of multipart/byteranges.
export interface ByteRange {
    readonly start: number;
    readonly end: number; // Inclusive, as Content-Range counts.
    readonly partial: boolean;
}

export const parseByteRange = (header: string | undefined, size: number): ByteRange | "unsatisfiable" => {
    const whole = { start: 0, end: Math.max(size - 1, 0), partial: false } as const;
    const match = header === undefined ? null : /^bytes=(\d*)-(\d*)$/.exec(header.trim());
    if (match === null) {
        return whole;
    }
    const [, from, to] = match;
    // A suffix range (`bytes=-500`) is the last n bytes; how a player reads a trailing index (unfaststarted MP4).
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

// A file's bytes as a web ReadableStream from start to end inclusive, streamed off disk rather than buffered.
// Lets a multi-GB recording cost one chunk of memory at a time instead of the whole file.
export const openWorkspaceFileRange = (absPath: string, start: number, end: number): ReadableStream<Uint8Array> => {
    return Readable.toWeb(createReadStream(absPath, { start, end })) as ReadableStream<Uint8Array>;
};
