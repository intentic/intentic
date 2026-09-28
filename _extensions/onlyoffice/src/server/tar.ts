// A streaming reader for the tar archives the editor bundle arrives in: ustar headers with the prefix field, pax
// extended headers (per-entry `path` and `size`), GNU long names, and nothing else a `git archive` writes. Entries are
// handed over one at a time with a body that must be consumed (or skipped) before the next is read, so the archive is
// never held in memory. Node has no tar of its own, and the backend bundles only what it writes.

const BLOCK = 512;

export type TarEntryType = "file" | "directory" | "other";

export interface TarEntry {
    readonly name: string;
    readonly type: TarEntryType;
    readonly size: number;
}

export type TarBody = AsyncIterable<Buffer>;

// Pulls exact byte counts out of a chunk stream without joining the whole of it.
class ByteReader {
    private chunks: Buffer[] = [];
    private buffered = 0;

    constructor(private readonly source: AsyncIterator<Buffer>) {}

    // Buffers at least `n` bytes; false when the source ended first.
    private async fill(n: number): Promise<boolean> {
        while (this.buffered < n) {
            const next = await this.source.next();
            if (next.done === true) {
                return false;
            }
            const chunk = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value);
            this.chunks.push(chunk);
            this.buffered += chunk.length;
        }
        return true;
    }

    // Exactly `n` bytes, or undefined when the source ended before any of them; a source that ends partway is a
    // truncated archive.
    async exactly(n: number): Promise<Buffer | undefined> {
        if (!(await this.fill(n))) {
            if (this.buffered === 0) {
                return undefined;
            }
            throw new Error("the archive ends in the middle of an entry");
        }
        const first = this.chunks[0];
        let taken: Buffer;
        if (first !== undefined && first.length >= n) {
            taken = first.subarray(0, n);
            this.chunks[0] = first.subarray(n);
        } else {
            const joined = Buffer.concat(this.chunks);
            taken = joined.subarray(0, n);
            this.chunks = [joined.subarray(n)];
        }
        this.buffered -= n;
        return taken;
    }

    // The next `n` bytes as they arrive.
    async *take(n: number): AsyncGenerator<Buffer> {
        let left = n;
        while (left > 0) {
            if (this.buffered === 0 && !(await this.fill(1))) {
                throw new Error("the archive ends in the middle of an entry");
            }
            const head = this.chunks[0] ?? Buffer.alloc(0);
            if (head.length === 0) {
                this.chunks.shift();
                continue;
            }
            const part = head.subarray(0, Math.min(left, head.length));
            this.chunks[0] = head.subarray(part.length);
            this.buffered -= part.length;
            left -= part.length;
            yield part;
        }
    }

    async skip(n: number): Promise<void> {
        for await (const part of this.take(n)) {
            void part;
        }
    }
}

// A NUL-terminated string field.
const text = (block: Buffer, start: number, length: number): string => {
    const field = block.subarray(start, start + length);
    const end = field.indexOf(0);
    return field.subarray(0, end === -1 ? field.length : end).toString("utf8");
};

// An octal number field. The base-256 form only appears for entries past 8 GB, which no bundle holds.
const octal = (block: Buffer, start: number, length: number): number => {
    const field = block.subarray(start, start + length);
    if (((field[0] ?? 0) & 0x80) !== 0) {
        throw new Error("the archive holds an entry too large to be an editor file");
    }
    const digits = text(field, 0, length).trim();
    const value = digits === "" ? 0 : Number.parseInt(digits, 8);
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error("the archive has a malformed header");
    }
    return value;
};

// The checksum a header's own bytes give, its checksum field counted as spaces.
const checksumOf = (block: Buffer): number => {
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) {
        sum += i >= 148 && i < 156 ? 0x20 : (block[i] ?? 0);
    }
    return sum;
};

const isZeroBlock = (block: Buffer): boolean => block.every((byte) => byte === 0);

// The `key=value` records of a pax extended header ("<length> <key>=<value>\n", length counting the whole record).
export const paxRecords = (body: Buffer): Map<string, string> => {
    const records = new Map<string, string>();
    let at = 0;
    while (at < body.length) {
        const space = body.indexOf(0x20, at);
        if (space === -1) {
            break;
        }
        const length = Number.parseInt(body.subarray(at, space).toString("utf8"), 10);
        if (!Number.isSafeInteger(length) || length <= space - at) {
            throw new Error("the archive has a malformed pax header");
        }
        const record = body.subarray(space + 1, at + length - 1).toString("utf8");
        const equals = record.indexOf("=");
        if (equals > 0) {
            records.set(record.slice(0, equals), record.slice(equals + 1));
        }
        at += length;
    }
    return records;
};

const padding = (size: number): number => (BLOCK - (size % BLOCK)) % BLOCK;

const typeOf = (flag: string): TarEntryType => {
    if (flag === "0" || flag === "" || flag === "7") {
        return "file";
    }
    return flag === "5" ? "directory" : "other";
};

// The next header block, or undefined at the archive's end marker (or a stream that simply stops between entries).
const nextHeader = async (reader: ByteReader): Promise<Buffer | undefined> => {
    const block = await reader.exactly(BLOCK);
    if (block === undefined || isZeroBlock(block)) {
        return undefined;
    }
    if (octal(block, 148, 8) !== checksumOf(block)) {
        throw new Error("the archive has a header whose checksum does not match");
    }
    return block;
};

// What pax and GNU headers said about the entry that follows them.
interface Pending {
    readonly name: string | undefined;
    readonly size: number | undefined;
}

const NOTHING_PENDING: Pending = { name: undefined, size: undefined };

// What a metadata header (pax `x` or `g`, GNU `L`) adds to what is pending; a global pax header changes nothing here.
const withMeta = (flag: string, body: Buffer, pending: Pending): Pending => {
    if (flag === "L") {
        return { name: text(body, 0, body.length), size: pending.size };
    }
    if (flag !== "x") {
        return pending;
    }
    const records = paxRecords(body);
    const size = records.get("size");
    return { name: records.get("path") ?? pending.name, size: size === undefined ? pending.size : Number.parseInt(size, 10) };
};

// A ustar entry's name: the prefix field and the name field, joined.
const nameOf = (block: Buffer): string => {
    const prefix = text(block, 345, 155);
    const name = text(block, 0, 100);
    return prefix === "" ? name : `${prefix}/${name}`;
};

// Hands one entry to `onEntry`, then skips whatever it left unread and the padding after it.
const deliver = async (reader: ByteReader, entry: TarEntry, onEntry: (entry: TarEntry, body: TarBody) => Promise<void>): Promise<void> => {
    let remaining = entry.size;
    const body: TarBody = {
        async *[Symbol.asyncIterator]() {
            for await (const part of reader.take(remaining)) {
                remaining -= part.length;
                yield part;
            }
        },
    };
    await onEntry(entry, body);
    await reader.skip(remaining);
    await reader.skip(padding(entry.size));
};

// Reads `source` (the decompressed archive) and calls `onEntry` for every entry in order. `onEntry` may read `body` to
// its end, part of it, or none; what it leaves is skipped. Resolves at the archive's end marker (or a clean end of
// stream), throws on a truncated or corrupt archive.
export const readTar = async (source: AsyncIterable<Buffer>, onEntry: (entry: TarEntry, body: TarBody) => Promise<void>): Promise<void> => {
    const reader = new ByteReader(source[Symbol.asyncIterator]());
    let pending = NOTHING_PENDING;
    for (let block = await nextHeader(reader); block !== undefined; block = await nextHeader(reader)) {
        const flag = text(block, 156, 1);
        const headerSize = octal(block, 124, 12);
        if (flag === "x" || flag === "g" || flag === "L") {
            const body = (await reader.exactly(headerSize)) ?? Buffer.alloc(0);
            await reader.skip(padding(headerSize));
            pending = withMeta(flag, body, pending);
            continue;
        }
        await deliver(reader, { name: pending.name ?? nameOf(block), type: typeOf(flag), size: pending.size ?? headerSize }, onEntry);
        pending = NOTHING_PENDING;
    }
};
