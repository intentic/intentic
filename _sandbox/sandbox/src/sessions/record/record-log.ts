import { randomUUID } from "node:crypto";
import { undefinedIfMissing } from "@intentic/base/errors";
import { crc32, constants, zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { type FileHandle, mkdir, open, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";

// A conversation's record on disk: zstd frames of JSONL, one per append (a settled turn), each preceded by a skippable
// frame naming its length, its row count and its checksum. zstd readers skip those, so `zstdcat` and `zstdgrep` read a
// record as the JSONL it holds; this module reads them to find any row without decompressing the frames before it.
// Appends only ever add to the end, and a crash can tear only the last frame, which the next change cuts away.

// The skippable frame's magic, little-endian as zstd lays it out; any of 0x184D2A50..5F is one, this one is ours.
const SKIPPABLE_MAGIC = 0x18_4d_2a_5e;
// Magic and length, then the frame's own length, its row count and its CRC-32.
const HEAD_BYTES = 8;
const META_BYTES = 12;
const PREFIX_BYTES = HEAD_BYTES + META_BYTES;
// The balance zstd's docs recommend for text: most of the ratio of higher levels at a fraction of their time.
const LEVEL = 6;

export interface Frame {
    // Where the data frame starts, past its skippable prefix, and how long it is.
    readonly offset: number;
    readonly length: number;
    readonly rows: number;
}

export interface LogIndex {
    readonly frames: readonly Frame[];
    // Rows before each frame, so a row's frame is a binary search.
    readonly firstRows: readonly number[];
    readonly rows: number;
    // Where the last whole frame ends; short of `size` when a torn frame, or one still being written, follows it.
    readonly end: number;
    readonly size: number;
    readonly mtimeMs: number;
}

// One append's bytes: the prefix that names it, then the frame of its JSONL.
export const frameBytes = (jsonl: string, rows: number): Buffer => {
    const data = zstdCompressSync(Buffer.from(jsonl, "utf8"), {
        params: { [constants.ZSTD_c_compressionLevel]: LEVEL, [constants.ZSTD_c_checksumFlag]: 1 },
    });
    const prefix = Buffer.allocUnsafe(PREFIX_BYTES);
    prefix.writeUInt32LE(SKIPPABLE_MAGIC, 0);
    prefix.writeUInt32LE(META_BYTES, 4);
    prefix.writeUInt32LE(data.length, 8);
    prefix.writeUInt32LE(rows, 12);
    prefix.writeUInt32LE(crc32(data), 16);
    return Buffer.concat([prefix, data]);
};

// JSONL for rows, each line ending in a newline: what a frame holds and what `zstdcat` prints.
export const jsonlOf = (lines: readonly string[]): string => lines.map((line) => `${line}\n`).join("");

const indexOf = (frames: Frame[], end: number, size: number, mtimeMs: number): LogIndex => {
    const firstRows: number[] = [];
    let rows = 0;
    for (const frame of frames) {
        firstRows.push(rows);
        rows += frame.rows;
    }
    return { frames, firstRows, rows, end, size, mtimeMs };
};

// Walks the prefixes from the start; the first one that does not describe a whole frame inside the file marks where the
// intact log ends. Only the last frame is decompressed, to check the one a crash could have torn.
const walk = async (handle: FileHandle, size: number): Promise<{ frames: Frame[]; intact: number }> => {
    const frames: Frame[] = [];
    const prefix = Buffer.allocUnsafe(PREFIX_BYTES);
    let at = 0;
    while (at + PREFIX_BYTES <= size) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- each prefix names where the next one is.
        await handle.read(prefix, 0, PREFIX_BYTES, at);
        if (prefix.readUInt32LE(0) !== SKIPPABLE_MAGIC || prefix.readUInt32LE(4) !== META_BYTES) {
            break;
        }
        const length = prefix.readUInt32LE(8);
        if (at + PREFIX_BYTES + length > size) {
            break;
        }
        frames.push({ offset: at + PREFIX_BYTES, length, rows: prefix.readUInt32LE(12) });
        at += PREFIX_BYTES + length;
    }
    const last = frames.at(-1);
    if (last !== undefined) {
        const data = Buffer.allocUnsafe(last.length);
        await handle.read(data, 0, last.length, last.offset);
        const sum = Buffer.allocUnsafe(4);
        await handle.read(sum, 0, 4, last.offset - 4);
        if (crc32(data) !== sum.readUInt32LE(0)) {
            frames.pop();
            at = last.offset - PREFIX_BYTES;
        }
    }
    return { frames, intact: at };
};

// The log's whole frames, read-only, so any reader may open it while an append is landing; undefined when there is none.
export const openLog = async (path: string): Promise<LogIndex | undefined> => {
    const handle = await open(path, "r").catch(undefinedIfMissing);
    if (handle === undefined) {
        return undefined;
    }
    try {
        const info = await handle.stat();
        const { frames, intact } = await walk(handle, info.size);
        return indexOf(frames, intact, info.size, info.mtimeMs);
    } finally {
        await handle.close();
    }
};

// Cuts a torn tail away so the next frame lands on a whole one; only the conversation's writer may, under its lock, since
// to anyone else a frame still being written looks torn.
export const repairLog = async (path: string, index: LogIndex): Promise<LogIndex> => {
    if (index.end === index.size) {
        return index;
    }
    const handle = await open(path, "r+");
    try {
        await handle.truncate(index.end);
        await handle.datasync();
        const repaired = await handle.stat();
        return indexOf([...index.frames], index.end, repaired.size, repaired.mtimeMs);
    } finally {
        await handle.close();
    }
};

// Adds one frame of rows at the end, durable once this resolves; answers the log's index after it. `known` must be
// whole (repairLog), or the frame lands past bytes no reader can step over.
export const appendLog = async (path: string, known: LogIndex | undefined, lines: readonly string[]): Promise<LogIndex> => {
    await mkdir(dirname(path), { recursive: true });
    const bytes = frameBytes(jsonlOf(lines), lines.length);
    const handle = await open(path, "a");
    try {
        await handle.write(bytes);
        await handle.datasync();
        const info = await handle.stat();
        const offset = info.size - bytes.length + PREFIX_BYTES;
        const frames = [...(known?.frames ?? []), { offset, length: bytes.length - PREFIX_BYTES, rows: lines.length }];
        return indexOf(frames, info.size, info.size, info.mtimeMs);
    } finally {
        await handle.close();
    }
};

// Writes a whole log from frames of lines, in place of whatever is there, never leaving a half-written one visible.
export const writeLog = async (path: string, frames: readonly (readonly string[])[]): Promise<void> => {
    await mkdir(dirname(path), { recursive: true });
    // Unique per write: worker threads share the process id, and two may write beside the same path.
    const temporary = `${path}.${randomUUID()}.tmp`;
    const handle = await open(temporary, "w");
    try {
        for (const lines of frames.filter((frame) => frame.length > 0)) {
            // oxlint-disable-next-line eslint/no-await-in-loop -- frames go down in order.
            await handle.write(frameBytes(jsonlOf(lines), lines.length));
        }
        await handle.datasync();
    } finally {
        await handle.close();
    }
    await rename(temporary, path).catch(async (error: unknown) => {
        await rm(temporary, { force: true });
        throw error;
    });
};

// One frame's lines, newline-split, the last empty piece dropped.
export const readFrame = async (path: string, frame: Frame): Promise<string[]> => {
    const handle = await open(path, "r");
    try {
        const data = Buffer.allocUnsafe(frame.length);
        await handle.read(data, 0, frame.length, frame.offset);
        const text = zstdDecompressSync(data).toString("utf8");
        const lines = text.split("\n");
        lines.pop();
        return lines;
    } finally {
        await handle.close();
    }
};

// The frame holding row `at`, and where in it: the last frame whose first row is at or before it.
export const frameOfRow = (index: LogIndex, at: number): { readonly frame: number; readonly line: number } => {
    let low = 0;
    let high = index.frames.length - 1;
    while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if ((index.firstRows[middle] ?? 0) <= at) {
            low = middle;
        } else {
            high = middle - 1;
        }
    }
    return { frame: low, line: at - (index.firstRows[low] ?? 0) };
};

// Whether the log's file still is the one this index describes.
export const current = async (path: string, index: LogIndex): Promise<boolean> => {
    const info = await stat(path).catch(undefinedIfMissing);
    return info !== undefined && info.size === index.size && info.mtimeMs === index.mtimeMs;
};
