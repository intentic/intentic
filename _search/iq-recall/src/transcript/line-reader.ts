import { createReadStream } from "node:fs";

// A transcript line larger than this is consumed (offsets stay exact) but yielded with json "" so callers
// skip it without buffering the whole thing.
const MAX_LINE_BYTES = 10 * 1024 * 1024;

export interface TranscriptLine {
    readonly json: string;
    // Absolute byte offset just past this line's terminating "\n" — the resume point after consuming it.
    readonly endByte: number;
}

// Streams complete lines of an append-only JSONL file from `fromByte` (which must sit on a line boundary).
// A trailing line without "\n" is never yielded — it is still being written; the caller resumes from the
// last endByte on the next pass. Offsets are byte-accurate under multibyte UTF-8.
export async function* readLines(path: string, fromByte: number): AsyncGenerator<TranscriptLine> {
    let offset = fromByte;
    // Buffers of the current partial line (dropped while skipping an oversized line); pendingBytes tracks the
    // true byte count either way so offsets never drift.
    let pending: Buffer[] = [];
    let pendingBytes = 0;
    let skipping = false;
    for await (const chunk of createReadStream(path, { start: fromByte }) as AsyncIterable<Buffer>) {
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
