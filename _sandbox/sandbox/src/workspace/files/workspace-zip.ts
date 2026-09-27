import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import { pipeline } from "node:stream";
import { promisify } from "node:util";
import { constants, crc32, createDeflateRaw, deflateRaw } from "node:zlib";

// A streaming ZIP writer for downloads: every entry is written as it is read off disk, so a folder of any size costs
// one read buffer of memory plus a small central-directory record per entry, and the first bytes leave at once.
// ZIP rather than tar because every desktop opens it with nothing installed. Each entry's CRC and sizes follow its
// data in a descriptor (general-purpose bit 3), which is what lets it stream; ZIP64 fields are used only where a size or
// offset needs them, so an ordinary archive stays readable by the oldest tools.

export interface ZipEntry {
    // Forward-slashed, relative, no leading slash; a directory's ends in `/`.
    readonly name: string;
    readonly kind: "file" | "dir";
    // Bytes to read from `source`, as the walk saw them; a file that grew since is cut at this length.
    readonly size: number;
    readonly mtimeMs: number;
    // Unix permission bits, so a script keeps its executable bit when unzipped.
    readonly mode: number;
    // 0 stores the bytes as they are, 8 deflates them.
    readonly method: 0 | 8;
    readonly source?: string;
}

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const DESCRIPTOR_SIG = 0x08074b50;
const END_SIG = 0x06054b50;
const END64_SIG = 0x06064b50;
const LOCATOR64_SIG = 0x07064b50;
const MAX32 = 0xffffffff;
const MAX16 = 0xffff;
// Bit 3: CRC and sizes follow the data. Bit 11: names are UTF-8.
const FLAGS = 0x0808;
// Deflate can outgrow its input by a few bytes per block, so an entry this close to 4 GiB is written as ZIP64 up front,
// before its compressed size is known.
const ZIP64_AT = 0xf0000000;
const READ_CHUNK = 1024 * 1024;
// A middling level: text shrinks about as much as at 9, several times faster, and the link is what's slow.
const DEFLATE_LEVEL = 5;

const needsZip64 = (entry: ZipEntry): boolean => entry.kind === "file" && entry.size >= ZIP64_AT;

// MS-DOS date and time, in the daemon's local time: the only clock an old reader knows. The extended timestamp beside it
// carries the true UTC second for every reader that looks.
const dosDateTime = (ms: number): { time: number; date: number } => {
    const at = new Date(Math.max(ms, Date.UTC(1980, 0, 1, 12)));
    const year = Math.min(at.getFullYear(), 2107);
    return {
        time: (at.getHours() << 11) | (at.getMinutes() << 5) | Math.floor(at.getSeconds() / 2),
        date: ((year - 1980) << 9) | ((at.getMonth() + 1) << 5) | at.getDate(),
    };
};

// 0x5455, the extended timestamp: flag 1 (mtime present) and the mtime in Unix seconds.
const timestampExtra = (ms: number): Buffer => {
    const extra = Buffer.alloc(9);
    extra.writeUInt16LE(0x5455, 0);
    extra.writeUInt16LE(5, 2);
    extra.writeUInt8(1, 4);
    extra.writeUInt32LE(Math.min(Math.max(Math.floor(ms / 1000), 0), MAX32), 5);
    return extra;
};

// 0x0001, the ZIP64 extra: only the fields whose 32-bit slot says "see ZIP64", in the order the spec fixes.
const zip64Extra = (fields: readonly number[]): Buffer => {
    if (fields.length === 0) {
        return Buffer.alloc(0);
    }
    const extra = Buffer.alloc(4 + fields.length * 8);
    extra.writeUInt16LE(0x0001, 0);
    extra.writeUInt16LE(fields.length * 8, 2);
    fields.forEach((field, index) => extra.writeBigUInt64LE(BigInt(field), 4 + index * 8));
    return extra;
};

const localHeader = (entry: ZipEntry, name: Buffer): Buffer => {
    const zip64 = needsZip64(entry);
    // Sizes are zero here and come in the descriptor; a ZIP64 entry says so with both slots at 0xFFFFFFFF.
    const extra = Buffer.concat([timestampExtra(entry.mtimeMs), zip64 ? zip64Extra([0, 0]) : Buffer.alloc(0)]);
    const header = Buffer.alloc(30);
    const { time, date } = dosDateTime(entry.mtimeMs);
    header.writeUInt32LE(LOCAL_SIG, 0);
    header.writeUInt16LE(zip64 ? 45 : 20, 4);
    header.writeUInt16LE(entry.kind === "file" ? FLAGS : 0x0800, 6);
    header.writeUInt16LE(entry.method, 8);
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(date, 12);
    header.writeUInt32LE(0, 14);
    header.writeUInt32LE(zip64 ? MAX32 : 0, 18);
    header.writeUInt32LE(zip64 ? MAX32 : 0, 22);
    header.writeUInt16LE(name.length, 26);
    header.writeUInt16LE(extra.length, 28);
    return Buffer.concat([header, name, extra]);
};

const descriptor = (zip64: boolean, crc: number, compressed: number, size: number): Buffer => {
    const out = Buffer.alloc(zip64 ? 24 : 16);
    out.writeUInt32LE(DESCRIPTOR_SIG, 0);
    out.writeUInt32LE(crc, 4);
    if (zip64) {
        out.writeBigUInt64LE(BigInt(compressed), 8);
        out.writeBigUInt64LE(BigInt(size), 16);
    } else {
        out.writeUInt32LE(compressed, 8);
        out.writeUInt32LE(size, 12);
    }
    return out;
};

// What an entry turned out to be once written: what the central directory records about it.
interface Written {
    readonly entry: ZipEntry;
    readonly name: Buffer;
    readonly crc: number;
    readonly compressed: number;
    readonly size: number;
    readonly offset: number;
}

const centralHeader = ({ entry, name, crc, compressed, size, offset }: Written): Buffer => {
    const zip64 = needsZip64(entry);
    const wideSize = zip64 || size >= MAX32;
    const wideCompressed = zip64 || compressed >= MAX32;
    const wideOffset = offset >= MAX32;
    const wide = [...(wideSize ? [size] : []), ...(wideCompressed ? [compressed] : []), ...(wideOffset ? [offset] : [])];
    const extra = Buffer.concat([timestampExtra(entry.mtimeMs), zip64Extra(wide)]);
    const header = Buffer.alloc(46);
    const { time, date } = dosDateTime(entry.mtimeMs);
    const needed = wide.length > 0 ? 45 : 20;
    header.writeUInt32LE(CENTRAL_SIG, 0);
    // Made by Unix (3), so the permission bits in the external attributes are read as such.
    header.writeUInt16LE((3 << 8) | 45, 4);
    header.writeUInt16LE(needed, 6);
    header.writeUInt16LE(entry.kind === "file" ? FLAGS : 0x0800, 8);
    header.writeUInt16LE(entry.method, 10);
    header.writeUInt16LE(time, 12);
    header.writeUInt16LE(date, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(wideCompressed ? MAX32 : compressed, 20);
    header.writeUInt32LE(wideSize ? MAX32 : size, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt16LE(extra.length, 30);
    header.writeUInt16LE(0, 32);
    header.writeUInt16LE(0, 34);
    header.writeUInt16LE(0, 36);
    const type = entry.kind === "dir" ? 0o040000 : 0o100000;
    // Unix mode in the high half; MS-DOS directory bit in the low one, for readers that only look there.
    header.writeUInt32LE((((type | (entry.mode & 0o7777)) << 16) | (entry.kind === "dir" ? 0x10 : 0)) >>> 0, 38);
    header.writeUInt32LE(wideOffset ? MAX32 : offset, 42);
    return Buffer.concat([header, name, extra]);
};

// The central directory's closing records; ZIP64's pair only when a count, size or offset overflows the classic one.
const endRecords = (count: number, directoryOffset: number, directorySize: number): Buffer => {
    const wide = count >= MAX16 || directoryOffset >= MAX32 || directorySize >= MAX32;
    const parts: Buffer[] = [];
    if (wide) {
        const record = Buffer.alloc(56);
        record.writeUInt32LE(END64_SIG, 0);
        record.writeBigUInt64LE(44n, 4);
        record.writeUInt16LE((3 << 8) | 45, 12);
        record.writeUInt16LE(45, 14);
        record.writeBigUInt64LE(BigInt(count), 24);
        record.writeBigUInt64LE(BigInt(count), 32);
        record.writeBigUInt64LE(BigInt(directorySize), 40);
        record.writeBigUInt64LE(BigInt(directoryOffset), 48);
        const locator = Buffer.alloc(20);
        locator.writeUInt32LE(LOCATOR64_SIG, 0);
        locator.writeBigUInt64LE(BigInt(directoryOffset + directorySize), 8);
        locator.writeUInt32LE(1, 16);
        parts.push(record, locator);
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(END_SIG, 0);
    end.writeUInt16LE(Math.min(count, MAX16), 8);
    end.writeUInt16LE(Math.min(count, MAX16), 10);
    end.writeUInt32LE(Math.min(directorySize, MAX32), 12);
    end.writeUInt32LE(Math.min(directoryOffset, MAX32), 16);
    parts.push(end);
    return Buffer.concat(parts);
};

const entryName = (entry: ZipEntry): Buffer => Buffer.from(entry.name, "utf8");

/**
 * The archive's exact length in bytes, known before a byte is read, when every entry is stored: the browser can then
 * show progress and time left. Undefined when anything deflates, since its size is only known once written.
 */
export const zipLength = (entries: readonly ZipEntry[]): number | undefined => {
    if (entries.some((entry) => entry.kind === "file" && entry.method !== 0)) {
        return undefined;
    }
    let offset = 0;
    const written: Written[] = [];
    for (const entry of entries) {
        const name = entryName(entry);
        written.push({ entry, name, crc: 0, compressed: entry.size, size: entry.size, offset });
        offset += localHeader(entry, name).length;
        if (entry.kind === "file") {
            offset += entry.size + descriptor(needsZip64(entry), 0, entry.size, entry.size).length;
        }
    }
    const directorySize = written.reduce((sum, record) => sum + centralHeader(record).length, 0);
    return offset + directorySize + endRecords(written.length, offset, directorySize).length;
};

// Thrown mid-stream when a file shrank under a download whose length was already promised: the only honest answer
// left is to stop, so the browser marks the download failed rather than saving a corrupt archive.
export class ZipSourceChangedError extends Error {
    constructor(name: string) {
        super(`${name} changed while it was being downloaded`);
    }
}

// Files up to this size are read whole, ahead of the writer: a folder of thousands of small files is otherwise one
// open-read-close round trip after another, the disk idle while each waits its turn. Bigger ones stream.
const SMALL_FILE = 256 * 1024;
// How far the read-ahead runs: enough to keep the libuv pool busy, bounded so memory stays a few megabytes.
const AHEAD_FILES = 64;
const AHEAD_BYTES = 8 * 1024 * 1024;

// A small file read (and deflated, when its method says so) before its turn to be written.
interface Prepared {
    readonly data: Buffer;
    readonly crc: number;
    readonly size: number;
}

const deflateRawAsync = promisify(deflateRaw);

// At most the size the walk saw, as a streamed read is cut: a log that grew since costs nothing extra.
const readUpTo = async (path: string, size: number): Promise<Buffer | undefined> => {
    const handle = await open(path, "r").catch(() => undefined);
    if (handle === undefined) {
        return undefined;
    }
    try {
        const buffer = Buffer.allocUnsafe(size);
        let got = 0;
        while (got < size) {
            const { bytesRead } = await handle.read(buffer, got, size - got, got);
            if (bytesRead === 0) {
                break;
            }
            got += bytesRead;
        }
        return buffer.subarray(0, got);
    } catch {
        return undefined;
    } finally {
        await handle.close().catch(() => undefined);
    }
};

const prepare = async (entry: ZipEntry): Promise<Prepared | undefined> => {
    const bytes = await readUpTo(entry.source ?? "", entry.size);
    if (bytes === undefined) {
        return undefined;
    }
    const data = entry.method === 8 ? await deflateRawAsync(bytes, { level: DEFLATE_LEVEL }) : bytes;
    return { data, crc: crc32(bytes), size: bytes.length };
};

const isSmallFile = (entry: ZipEntry): boolean => entry.kind === "file" && entry.source !== undefined && entry.size <= SMALL_FILE;

/**
 * The archive, as chunks to send in order. `exact` means the length from `zipLength` was promised, so a file that
 * changed size under the read aborts instead of skewing it; otherwise a file that vanished is left out and a changed
 * one is written as it now is.
 */
export async function* zipChunks(entries: readonly ZipEntry[], exact: boolean): AsyncGenerator<Buffer> {
    let offset = 0;
    const written: Written[] = [];
    // Small files from the writer's position on, already being read; a big file ends the run until it is written.
    const ahead = new Map<number, Promise<Prepared | undefined>>();
    let nextAhead = 0;
    let aheadBytes = 0;
    const readAhead = (from: number): void => {
        nextAhead = Math.max(nextAhead, from);
        while (nextAhead < entries.length && ahead.size < AHEAD_FILES && aheadBytes < AHEAD_BYTES) {
            const entry = entries[nextAhead] as ZipEntry;
            if (entry.kind === "file" && !isSmallFile(entry)) {
                break;
            }
            if (entry.kind === "file") {
                const prepared = prepare(entry);
                // Settled either way, so a read the consumer never reaches (a cancelled download) is no unhandled rejection.
                prepared.catch(() => undefined);
                ahead.set(nextAhead, prepared);
                aheadBytes += entry.size;
            }
            nextAhead += 1;
        }
    };
    for (const [index, entry] of entries.entries()) {
        readAhead(index);
        const name = entryName(entry);
        if (entry.kind === "dir" || entry.source === undefined) {
            const header = localHeader(entry, name);
            written.push({ entry, name, crc: 0, compressed: 0, size: 0, offset });
            offset += header.length;
            yield header;
            continue;
        }
        const early = ahead.get(index);
        if (early !== undefined) {
            ahead.delete(index);
            aheadBytes -= entry.size;
            const prepared = await early;
            if (prepared === undefined || (exact && prepared.size !== entry.size)) {
                if (exact) {
                    throw new ZipSourceChangedError(entry.name);
                }
                continue;
            }
            const header = localHeader(entry, name);
            const tail = descriptor(needsZip64(entry), prepared.crc, prepared.data.length, prepared.size);
            written.push({ entry, name, crc: prepared.crc, compressed: prepared.data.length, size: prepared.size, offset });
            offset += header.length + prepared.data.length + tail.length;
            // One chunk for the whole entry: thousands of tiny files are otherwise three writes each.
            yield Buffer.concat([header, prepared.data, tail]);
            continue;
        }
        const source = await openSource(entry.source, entry.size);
        if (source === undefined) {
            if (exact) {
                throw new ZipSourceChangedError(entry.name);
            }
            continue;
        }
        const header = localHeader(entry, name);
        const start = offset;
        offset += header.length;
        yield header;
        let crc = 0;
        let size = 0;
        let compressed = 0;
        const raw = (async function* () {
            for await (const chunk of source as AsyncIterable<Buffer>) {
                crc = crc32(chunk, crc);
                size += chunk.length;
                yield chunk;
            }
        })();
        const body: AsyncIterable<Buffer> =
            entry.method === 8
                ? pipeline(
                      raw,
                      createDeflateRaw({ level: DEFLATE_LEVEL, chunkSize: 64 * 1024, strategy: constants.Z_DEFAULT_STRATEGY }),
                      () => undefined,
                  )
                : raw;
        for await (const chunk of body) {
            compressed += chunk.length;
            yield chunk;
        }
        if (exact && size !== entry.size) {
            throw new ZipSourceChangedError(entry.name);
        }
        const tail = descriptor(needsZip64(entry), crc, compressed, size);
        offset += compressed + tail.length;
        yield tail;
        written.push({ entry, name, crc, compressed, size, offset: start });
    }
    const directoryOffset = offset;
    let directorySize = 0;
    for (const record of written) {
        const header = centralHeader(record);
        directorySize += header.length;
        yield header;
    }
    yield endRecords(written.length, directoryOffset, directorySize);
}

// The file's first `size` bytes, or undefined when it can no longer be opened. Opened before its header is written, so
// a file deleted since the walk is left out cleanly rather than half-written.
const openSource = async (path: string, size: number): Promise<AsyncIterable<Buffer> | undefined> => {
    if (size === 0) {
        return (async function* () {})();
    }
    const stream = createReadStream(path, { start: 0, end: size - 1, highWaterMark: READ_CHUNK });
    return new Promise((resolve) => {
        stream.once("open", () => resolve(stream));
        stream.once("error", () => resolve(undefined));
    });
};
