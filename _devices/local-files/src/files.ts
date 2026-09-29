import { createHash, randomBytes } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { chmod, lstat, open, readFile, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { errnoCode } from "@intentic/base/errors";
import { nodeStream, webStream } from "@intentic/base/web-stream";

// Reads and writes of one file, with the daemon's semantics for /work (_sandbox/sandbox/src/workspace/files/
// workspace-files.ts): a text read is a window cut on character and line boundaries, never the whole file; a raw read
// carries a validator that moves with the bytes; a save names the text it replaces by hash and is refused when the file
// moved under it. Writes land whole: the bytes go beside the file first and replace it by rename, so another program
// reading it never sees half a save.

// One text window's cap, the daemon's own.
export const MAX_TEXT_BYTES = 4 * 1024 * 1024;

// One raw read's cap, the daemon's own: the browser holds the whole answer as a Blob.
export const MAX_RAW_BYTES = 25 * 1024 * 1024;

// One save's cap. The editor's text saves are bounded far below this; it stops a runaway body filling the disk.
export const MAX_WRITE_BYTES = 256 * 1024 * 1024;

export interface FileWindow {
    readonly content: string;
    readonly size: number;
    readonly offset: number;
    readonly bytes: number;
    // The window's bytes are not UTF-8, so `content` holds replacement characters where they failed to decode.
    readonly lossy?: true;
}

// Whether bytes decode as UTF-8 with nothing replaced. A window is cut on character boundaries (below), so a UTF-8
// file's window always passes and a failure is the file's own.
export const isUtf8 = (bytes: Uint8Array): boolean => {
    try {
        new TextDecoder(`utf-8`, { fatal: true }).decode(bytes);
        return true;
    } catch {
        // allow(silent-catch): the decoder's only complaint is the one this answers.
        return false;
    }
};

// A utf8 continuation byte (0b10xxxxxx): the middle of a character, never a cut point.
const isContinuation = (byte: number): boolean => (byte & 0b1100_0000) === 0b1000_0000;

// Bytes in a character from its lead byte.
const sequenceLength = (byte: number): number => (byte >= 0b1111_0000 ? 4 : byte >= 0b1110_0000 ? 3 : byte >= 0b1100_0000 ? 2 : 1);

// Where a window's clean text starts and ends inside the bytes read for it.
interface ByteRange {
    readonly start: number;
    readonly end: number;
}

// Trims a byte window to a clean decode: no partial character or line at a boundary that is not the file's own end.
const trimToBoundaries = (buffer: Buffer, atStart: boolean, atEnd: boolean): ByteRange => {
    let start = 0;
    let end = buffer.length;
    if (!atStart) {
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

// A window of a file's text; undefined when it is missing or not a file. A negative offset reads the tail.
export const readWindow = async (abs: string, offset = 0, limit = MAX_TEXT_BYTES): Promise<FileWindow | undefined> => {
    let handle;
    try {
        handle = await open(abs, `r`);
        const found = await handle.stat();
        if (!found.isFile()) {
            return undefined;
        }
        const size = found.size;
        const window = Math.min(Math.max(limit, 0), MAX_TEXT_BYTES);
        const from = Math.min(offset < 0 ? Math.max(size + offset, 0) : offset, size);
        // One byte before the window tells a read that starts mid-line from one at a line's start; not returned.
        const probe = from > 0 ? 1 : 0;
        const buffer = Buffer.alloc(Math.min(window, size - from) + probe);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, from - probe);
        const slice = buffer.subarray(probe, bytesRead);
        const atStart = probe === 0 || buffer[0] === 0x0a;
        const { start, end } = trimToBoundaries(slice, atStart, from + slice.length >= size);
        const read = { content: slice.toString(`utf8`, start, end), size, offset: from + start, bytes: end - start };
        return isUtf8(slice.subarray(start, end)) ? read : { ...read, lossy: true };
    } catch {
        // allow(silent-catch): an unreadable file reads as absent, which is what the explorer can do something with.
        return undefined;
    } finally {
        await handle?.close();
    }
};

// Content-Type by extension for raw reads, the daemon's table: audio and video need a real type or the element refuses
// to decode them.
const MIME_BY_EXT = new Map(
    Object.entries({
        png: `image/png`,
        jpg: `image/jpeg`,
        jpeg: `image/jpeg`,
        gif: `image/gif`,
        webp: `image/webp`,
        avif: `image/avif`,
        svg: `image/svg+xml`,
        bmp: `image/bmp`,
        ico: `image/x-icon`,
        pdf: `application/pdf`,
        mp3: `audio/mpeg`,
        wav: `audio/wav`,
        ogg: `audio/ogg`,
        oga: `audio/ogg`,
        opus: `audio/ogg`,
        weba: `audio/webm`,
        flac: `audio/flac`,
        m4a: `audio/mp4`,
        aac: `audio/aac`,
        mp4: `video/mp4`,
        m4v: `video/mp4`,
        webm: `video/webm`,
        ogv: `video/ogg`,
        mov: `video/quicktime`,
    }),
);

export const contentTypeFor = (abs: string): string => MIME_BY_EXT.get(extname(abs).slice(1).toLowerCase()) ?? `application/octet-stream`;

export interface OpenedFile {
    readonly size: number;
    // Moves whenever the bytes may have: a replacing rename moves the inode, a write the size or the time.
    readonly tag: string;
    readonly body: () => ReadableStream<Uint8Array>;
}

export const openFile = async (abs: string): Promise<OpenedFile | undefined> => {
    try {
        const found = await stat(abs);
        if (!found.isFile()) {
            return undefined;
        }
        const tag = `W/"${[found.ino, found.size, Math.round(found.mtimeMs * 1000)].map((part) => part.toString(36)).join(`-`)}"`;
        return {
            size: found.size,
            tag,
            body: () => webStream<Uint8Array>(Readable.toWeb(createReadStream(abs))),
        };
    } catch {
        // allow(silent-catch): an unreadable file is answered as absent, a 404 the viewer shows as such.
        return undefined;
    }
};

// sha256 over the text's utf8 bytes, what the editor computes from the same decoded string it last read.
export const sha256Text = (text: string): string => createHash(`sha256`).update(text, `utf8`).digest(`hex`);

// Why a save was not made: the file moved under it, another program holds it (Word keeps a document it has open locked
// on Windows), this user may not write it, it is past the cap, or it is not UTF-8 text the editor could write back.
export type WriteRefusal = `changed` | `busy` | `denied` | `too-large` | `not-text`;

// The name a save is written under before it replaces the file, so the watcher can tell its own writes' debris apart.
export const TEMPORARY_MARK = `.intentic-save-`;

const refusalOf = (code: string | undefined): WriteRefusal | undefined => {
    if (code === `EBUSY` || (code === `EPERM` && process.platform === `win32`)) {
        return `busy`;
    }
    // A link where the file was a moment ago, which the open refused to follow.
    if (code === `ELOOP`) {
        return `changed`;
    }
    return code === `EACCES` || code === `EPERM` || code === `EROFS` ? `denied` : undefined;
};

// No write here follows a link at the file it opens. `O_NOFOLLOW` says so to the open where the platform has it (not
// Windows, which the lstat before a part's write stands in for); the file a save creates must not exist at all, and
// `O_EXCL` refuses a link there as well, dangling or not.
const NO_FOLLOW = `O_NOFOLLOW` in constants ? constants.O_NOFOLLOW : 0;
const CREATE_NEW = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW;
const IN_PLACE = constants.O_WRONLY | NO_FOLLOW;

// A body past the cap, caught by what it sends: one that declares no length (a chunked upload) is held to the cap all
// the same.
class TooLarge extends Error {
    constructor() {
        super(`file too large`);
    }
}

// Counts a body's bytes on their way to disk and fails the write at the chunk that would pass `limit`, so the file never
// holds more than the cap.
const capped = (limit: number): Transform => {
    let seen = 0;
    return new Transform({
        transform(chunk: Uint8Array, _encoding, done) {
            seen += chunk.byteLength;
            if (seen > limit) {
                done(new TooLarge());
                return;
            }
            done(undefined, chunk);
        },
    });
};

// What a write takes: the bytes whole, or a request's body as it arrives.
export type WriteSource = Uint8Array | ReadableStream<Uint8Array>;

const readableOf = (source: WriteSource): Readable => (source instanceof Uint8Array ? Readable.from([source]) : Readable.fromWeb(nodeStream(source)));

// Streams `source` into `abs` from byte `start`, opened with `flags` and held to `limit`.
const streamInto = async (abs: string, flags: number, source: WriteSource, limit: number, start = 0): Promise<void> => {
    const handle = await open(abs, flags);
    try {
        await pipeline(readableOf(source), capped(limit), handle.createWriteStream({ start }));
    } finally {
        await handle.close();
    }
};

// Why a text save names text the file does not hold: gone, not UTF-8 (the editor read it with replacement characters,
// and writing those back would change every byte they stand for), or changed since it was read.
const textRefusal = async (abs: string, baseHash: string): Promise<WriteRefusal | undefined> => {
    // allow(silent-catch): a file that is gone no longer holds the text the save was based on, which is the refusal.
    const current = await readFile(abs).catch(() => undefined);
    if (current === undefined) {
        return `changed`;
    }
    if (!isUtf8(current)) {
        return `not-text`;
    }
    return sha256Text(current.toString(`utf8`)) === baseHash ? undefined : `changed`;
};

// A save of `source` over `abs`: the editor's text, or the first part of a drop. `baseHash`, when given, is the hash of
// the text the editor last read; a file whose text no longer hashes to it, or that is not UTF-8, is not overwritten.
// The replaced file's permissions carry over, so saving a script keeps it runnable. The bytes stream into a new name
// beside the file and replace it by rename, which replaces a link rather than following it, and a body past the cap
// leaves the file as it was.
export const writeFileWhole = async (
    abs: string,
    source: WriteSource,
    baseHash: string | undefined,
    cap = MAX_WRITE_BYTES,
): Promise<WriteRefusal | undefined> => {
    const refused = baseHash === undefined ? undefined : await textRefusal(abs, baseHash);
    if (refused !== undefined) {
        return refused;
    }
    // allow(silent-catch): a new file has no mode to keep.
    const previous = await lstat(abs).catch(() => undefined);
    const temporary = join(dirname(abs), `.${basename(abs)}${TEMPORARY_MARK}${randomBytes(4).toString(`hex`)}.tmp`);
    try {
        await streamInto(temporary, CREATE_NEW, source, cap);
        if (previous?.isFile() === true) {
            await chmod(temporary, previous.mode & 0o7777);
        }
        await rename(temporary, abs);
        return undefined;
    } catch (error) {
        await rm(temporary, { force: true });
        const refusal = error instanceof TooLarge ? `too-large` : refusalOf(errnoCode(error));
        if (refusal !== undefined) {
            return refusal;
        }
        throw error;
    }
};

// A later part of a drop, written where it goes in the file its first part made, as the daemon does
// (workspace-files-upload.ts). The file is looked at right before it is opened, and must still be a file: a link put
// there since the path was resolved is refused, not followed. A part past the cap keeps what came before it, as the
// daemon's does; a retry resends the drop from its first part.
export const writePartAt = async (abs: string, body: ReadableStream<Uint8Array>, offset: number, cap = MAX_WRITE_BYTES): Promise<WriteRefusal | undefined> => {
    // allow(silent-catch): nothing there is a file the first part made and something since removed, the refusal below.
    const entry = await lstat(abs).catch(() => undefined);
    if (entry?.isFile() !== true) {
        return `changed`;
    }
    try {
        await streamInto(abs, IN_PLACE, body, cap - offset, offset);
        return undefined;
    } catch (error) {
        const refusal = error instanceof TooLarge ? `too-large` : refusalOf(errnoCode(error));
        if (refusal !== undefined) {
            return refusal;
        }
        throw error;
    }
};
