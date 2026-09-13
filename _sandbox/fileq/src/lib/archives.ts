import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { unzipSync } from "fflate";
import { onPath } from "./tools.js";

// Reading an archive's SHAPE without unpacking it: which members are inside and how big each is, never their bytes.
// Three containers are read in process — zip's central directory, tar's header blocks, gzip's trailer — because those
// are the ones whose index is readable without a decompressor this package carries.
// Everything else (xz, bzip2, zstd) is listed by GNU tar when the image carries it, since the codecs are on the image
// but not in node_modules; a container nothing here can open is named as unlistable rather than guessed at.

const run = promisify(execFile);

export interface ArchiveEntry {
    readonly path: string;
    /** Unpacked bytes; undefined where the container records none (a tar listing's directory, a streamed zip entry). */
    readonly size: number | undefined;
    /** Bytes the member occupies inside the archive; zip alone records both, so it alone can state a ratio. */
    readonly packed: number | undefined;
    readonly directory: boolean;
}

/**
 * Every member of a zip, from the central directory alone.
 * The filter is an enumeration hook: answering false for all of them walks the index and inflates nothing, which is
 * also what keeps an entry compressed by a method fflate lacks (or encrypted) listable rather than fatal.
 */
export const zipEntries = (bytes: Uint8Array): ArchiveEntry[] => {
    const entries: ArchiveEntry[] = [];
    unzipSync(bytes, {
        filter: (file) => {
            entries.push({ path: file.name, size: file.originalSize, packed: file.size, directory: file.name.endsWith("/") });
            return false;
        },
    });
    return entries;
};

const BLOCK = 512;
const decoder = new TextDecoder();

// A NUL-terminated ASCII field, which is how every string in a tar header is written.
const field = (bytes: Uint8Array, offset: number, length: number): string => {
    const raw = bytes.subarray(offset, offset + length);
    const end = raw.indexOf(0);
    return decoder.decode(end === -1 ? raw : raw.subarray(0, end)).trim();
};

// Numeric fields are octal text. A base-256 field (the >8GB encoding) reads as 0, which only a file far past the
// derivation size cap could carry.
const octal = (bytes: Uint8Array, offset: number, length: number): number => {
    const text = field(bytes, offset, length).replaceAll(/[^0-7]/g, "");
    return text === "" ? 0 : Number.parseInt(text, 8);
};

// The header's own checksum, with the checksum field itself read as spaces. The one test that recognizes a pre-POSIX
// tar, which carries no `ustar` magic at all.
const headerChecks = (block: Uint8Array): boolean => {
    if (block.length < BLOCK) {
        return false;
    }
    let sum = 0;
    for (let index = 0; index < BLOCK; index++) {
        sum += index >= 148 && index < 156 ? 0x20 : (block[index] ?? 0);
    }
    return sum === octal(block, 148, 8);
};

/** Whether these bytes open with a tar header, by magic or by checksum. */
export const looksLikeTar = (bytes: Uint8Array): boolean => bytes.length >= BLOCK && (field(bytes, 257, 6).startsWith("ustar") || headerChecks(bytes));

// A pax record block: `<length> <key>=<value>\n`, repeated. Only `path` matters here, and it overrides the ustar name.
const paxPath = (data: Uint8Array): string | undefined => {
    for (const record of decoder.decode(data).split("\n")) {
        const match = /^\d+ path=(.*)$/.exec(record);
        if (match !== null) {
            return match[1];
        }
    }
    return undefined;
};

interface TarBlock {
    readonly header: Uint8Array;
    /** One of tar's typeflags: "" or "0" a file, "5" a directory, "L"/"x" a name carrier, "g" archive defaults. */
    readonly type: string;
    readonly size: number;
    readonly data: Uint8Array;
    /** Offset of the block after this one's data, already rounded up to the 512-byte grid. */
    readonly next: number;
}

// The block at `offset`, or undefined at the zero block that ends every tar (and at a truncated tail).
const blockAt = (bytes: Uint8Array, offset: number): TarBlock | undefined => {
    if (offset + BLOCK > bytes.length) {
        return undefined;
    }
    const header = bytes.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) {
        return undefined;
    }
    const size = octal(header, 124, 12);
    return {
        header,
        type: field(header, 156, 1),
        size,
        data: bytes.subarray(offset + BLOCK, offset + BLOCK + size),
        next: offset + BLOCK + Math.ceil(size / BLOCK) * BLOCK,
    };
};

// Blocks that name the entry after them instead of being one; a path longer than the 100-byte name field arrives here.
const NAME_CARRIERS: ReadonlySet<string> = new Set(["L", "x", "X", "g"]);

const carriedName = (block: TarBlock, current: string | undefined): string | undefined => {
    if (block.type === "L") {
        return field(block.data, 0, block.data.length);
    }
    // "g" carries defaults for the whole archive rather than a name, so it leaves the pending one alone.
    return block.type === "g" ? current : (paxPath(block.data) ?? current);
};

const entryOf = (block: TarBlock, carried: string | undefined): ArchiveEntry => {
    const prefix = field(block.header, 345, 155);
    const name = field(block.header, 0, 100);
    const path = carried ?? (prefix === "" ? name : `${prefix}/${name}`);
    const directory = block.type === "5" || path.endsWith("/");
    return { path, size: directory ? undefined : block.size, packed: undefined, directory };
};

/**
 * Every member of a tar, by walking its header blocks and skipping the data between them.
 * Throws when the first block is not a header, which is how a file lying about being a tar becomes a loud skip.
 */
export const tarEntries = (bytes: Uint8Array): ArchiveEntry[] => {
    if (!looksLikeTar(bytes)) {
        throw new Error("not a tar archive: no header block at the start");
    }
    const entries: ArchiveEntry[] = [];
    // Set by a name-carrying block for the entry that follows it, cleared the moment that entry consumes it.
    let carried: string | undefined;
    let offset = 0;
    for (let block = blockAt(bytes, offset); block !== undefined; block = blockAt(bytes, offset)) {
        offset = block.next;
        if (NAME_CARRIERS.has(block.type)) {
            carried = carriedName(block, carried);
            continue;
        }
        entries.push(entryOf(block, carried));
        carried = undefined;
    }
    return entries;
};

export interface GzipHead {
    /** The member name gzip stored, when it stored one; a file compressed from stdin carries none. */
    readonly name: string | undefined;
    /** Unpacked size from the trailer, exact below 4 GiB and wrapped above it, which nothing derived here reaches. */
    readonly unpackedBytes: number;
}

// FNAME, the NUL-terminated original name, sits after the fixed header and after FEXTRA's own length-prefixed block.
const gzipName = (bytes: Uint8Array, flags: number): string | undefined => {
    if ((flags & 0x08) === 0) {
        return undefined;
    }
    const extra = (flags & 0x04) === 0 ? 0 : 2 + ((bytes[10] ?? 0) | ((bytes[11] ?? 0) << 8));
    const end = bytes.indexOf(0, 10 + extra);
    const name = end === -1 ? "" : decoder.decode(bytes.subarray(10 + extra, end));
    return name === "" ? undefined : name;
};

/** A gzip member's header and trailer facts, without inflating a byte; undefined when the bytes are not gzip. */
export const gzipHead = (bytes: Uint8Array): GzipHead | undefined => {
    if (bytes.length < 18 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) {
        return undefined;
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset + bytes.length - 4, 4);
    return { name: gzipName(bytes, bytes[3] ?? 0), unpackedBytes: view.getUint32(0, true) };
};

/** Whether GNU tar is on PATH, which is what lets this tier list the codecs node_modules cannot decompress. */
export const tarOnPath = (): boolean => onPath("tar");

// `tar -tvf` prints `<mode> <owner/group> <size> <date> <time> <path>`; the path is the rest of the line, so a name
// with spaces in it survives.
const LISTING_LINE = /^(\S+)\s+\S+\s+(\d+)\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?\s+(.+)$/;

/** Parses `tar -tvf` output; split out from the spawn so the shape of a listing is testable without a tar on PATH. */
export const parseTarListing = (stdout: string): ArchiveEntry[] => {
    const entries: ArchiveEntry[] = [];
    for (const line of stdout.split("\n")) {
        const match = LISTING_LINE.exec(line);
        if (match === null) {
            continue;
        }
        const [, mode = "", size = "0", path = ""] = match;
        // A link prints as `target -> source`; the member is the name on the left of the arrow.
        const directory = mode.startsWith("d");
        entries.push({ path: path.split(" -> ")[0] ?? path, size: directory ? undefined : Number(size), packed: undefined, directory });
    }
    return entries;
};

// Long enough for a large archive's index, short enough that a hung tar cannot hold the sweep behind it.
const TAR_TIMEOUT_MS = 60_000;
const TAR_MAX_BUFFER = 16 * 1024 * 1024;

/** Lists an archive through GNU tar, which auto-detects gzip, bzip2, xz and zstd on read. */
export const listWithTar = async (absPath: string): Promise<ArchiveEntry[]> => {
    const { stdout } = await run("tar", ["-tvf", absPath], { timeout: TAR_TIMEOUT_MS, maxBuffer: TAR_MAX_BUFFER });
    return parseTarListing(stdout);
};
