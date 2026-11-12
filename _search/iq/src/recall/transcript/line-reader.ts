import { createReadStream, existsSync } from "node:fs";
import { createZstdDecompress } from "node:zlib";

// A transcript line larger than this is consumed (offsets stay exact) but yielded with json "" so callers
// skip it without buffering the whole thing.
const MAX_LINE_BYTES = 10 * 1024 * 1024;

export interface TranscriptLine {
    readonly json: string;
    // Absolute byte offset just past this line's terminating "\n", the resume point after consuming it.
    readonly endByte: number;
}

// A transcript the sandbox compressed beside itself once nothing had written it for a week (`<id>.jsonl.zst`, the
// daemon's sessions/cold-sessions.ts, 2026-11-12). Nothing appends to one: a session resumed again is decompressed back
// to its plain name first, under the same mtime, so an index of either reads the same bytes at the same offsets.
export const COMPRESSED = ".zst";

// Streams complete lines of an append-only JSONL file from `fromByte` (which must sit on a line boundary).
// A trailing line without "\n" is never yielded, it is still being written; the caller resumes from the
// last endByte on the next pass. Offsets are byte-accurate under multibyte UTF-8.
export const readLines = (path: string, fromByte: number): AsyncGenerator<TranscriptLine> =>
    linesOf(createReadStream(path, { start: fromByte }), fromByte);

// The same lines out of a compressed transcript (`path` is the `.zst`), offsets counted in the plain bytes it holds, so
// a resume point stored while the file was plain still names the same line. The bytes before `fromByte` are
// decompressed and dropped: a compressed file cannot be entered part way.
export const readCompressedLines = (path: string, fromByte: number): AsyncGenerator<TranscriptLine> =>
    linesOf(skipped(decompressed(path), fromByte), fromByte);

// A transcript's lines whichever way it is kept: plain when its plain name is there, else from its compressed copy.
export const readTranscriptLines = (path: string, fromByte: number): AsyncGenerator<TranscriptLine> =>
    !existsSync(path) && existsSync(`${path}${COMPRESSED}`) ? readCompressedLines(`${path}${COMPRESSED}`, fromByte) : readLines(path, fromByte);

// A read failure ends the decompressed stream with it, rather than leaving its reader waiting on bytes that never come.
const decompressed = (path: string): AsyncIterable<Buffer> => {
    const source = createReadStream(path);
    const zstd = createZstdDecompress();
    source.on("error", (error) => zstd.destroy(error));
    return source.pipe(zstd);
};

async function* skipped(chunks: AsyncIterable<Buffer>, bytes: number): AsyncGenerator<Buffer> {
    let left = bytes;
    for await (const chunk of chunks) {
        if (left >= chunk.length) {
            left -= chunk.length;
            continue;
        }
        yield left === 0 ? chunk : chunk.subarray(left);
        left = 0;
    }
}

async function* linesOf(chunks: AsyncIterable<Buffer>, fromByte: number): AsyncGenerator<TranscriptLine> {
    let offset = fromByte;
    // Buffers of the current partial line (dropped while skipping an oversized line); pendingBytes tracks the
    // true byte count either way so offsets never drift.
    let pending: Buffer[] = [];
    let pendingBytes = 0;
    let skipping = false;
    for await (const chunk of chunks) {
        let begin = 0;
        for (let nl = chunk.indexOf(0x0a, begin); nl !== -1; nl = chunk.indexOf(0x0a, begin)) {
            offset += pendingBytes + (nl - begin) + 1;
            if (skipping) {
                yield { json: "", endByte: offset };
            } else {
                const tail = chunk.subarray(begin, nl);
                const line = pending.length === 0 ? tail : Buffer.concat([...pending, tail]);
                yield { json: line.toString("utf8"), endByte: offset };
            }
            pending = [];
            pendingBytes = 0;
            skipping = false;
            begin = nl + 1;
        }
        const rest = chunk.subarray(begin);
        pendingBytes += rest.length;
        if (!skipping && pendingBytes > MAX_LINE_BYTES) {
            skipping = true;
            pending = [];
        }
        if (!skipping && rest.length > 0) {
            // Copy: subarray would pin the stream's pooled slab for the lifetime of the partial line.
            pending.push(Buffer.from(rest));
        }
    }
}
