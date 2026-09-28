import { gzipSync } from "node:zlib";

// Shared fixtures for this package's tests; nothing here is bundled.

export interface TarFixtureEntry {
    readonly name: string;
    readonly body?: string | Buffer;
    // `file` by default. `pax-name` writes a pax header for the name, `gnu-name` a GNU long-name entry, and `prefix`
    // splits the name into the ustar prefix field, the three ways a long path reaches a tar.
    readonly type?: "file" | "directory" | "symlink";
    readonly longName?: "pax-name" | "gnu-name" | "prefix";
}

const writeOctal = (block: Buffer, offset: number, length: number, value: number): void => {
    block.write(`${value.toString(8).padStart(length - 1, `0`)}\0`, offset, length, `ascii`);
};

const header = (name: string, size: number, flag: string, prefix = ``): Buffer => {
    const block = Buffer.alloc(512);
    block.write(name, 0, 100, `utf8`);
    writeOctal(block, 100, 8, 0o644);
    writeOctal(block, 108, 8, 0);
    writeOctal(block, 116, 8, 0);
    writeOctal(block, 124, 12, size);
    writeOctal(block, 136, 12, 0);
    block.write(flag, 156, 1, `ascii`);
    block.write(`ustar\0`, 257, 6, `ascii`);
    block.write(`00`, 263, 2, `ascii`);
    block.write(prefix, 345, 155, `utf8`);
    block.fill(0x20, 148, 156);
    let sum = 0;
    for (const byte of block) {
        sum += byte;
    }
    block.write(`${sum.toString(8).padStart(6, `0`)}\0 `, 148, 8, `ascii`);
    return block;
};

const padded = (body: Buffer): Buffer => Buffer.concat([body, Buffer.alloc((512 - (body.length % 512)) % 512)]);

// One pax record, its leading length counting the whole record including itself.
const paxRecord = (key: string, value: string): string => {
    const rest = ` ${key}=${value}\n`;
    let length = Buffer.byteLength(rest) + 1;
    while (String(length).length + Buffer.byteLength(rest) !== length) {
        length = String(length).length + Buffer.byteLength(rest);
    }
    return `${length}${rest}`;
};

// An uncompressed tar of `entries`, ended by the two zero blocks.
export const tarOf = (entries: readonly TarFixtureEntry[]): Buffer => {
    const blocks: Buffer[] = [];
    for (const entry of entries) {
        const body = Buffer.from(entry.body ?? ``);
        const flag = entry.type === `directory` ? `5` : entry.type === `symlink` ? `2` : `0`;
        const size = entry.type === `file` || entry.type === undefined ? body.length : 0;
        if (entry.longName === `pax-name`) {
            const records = Buffer.from(paxRecord(`path`, entry.name));
            blocks.push(header(`PaxHeader`, records.length, `x`), padded(records));
            blocks.push(header(entry.name.slice(0, 100), size, flag));
        } else if (entry.longName === `gnu-name`) {
            const longName = Buffer.from(`${entry.name}\0`);
            blocks.push(header(`././@LongLink`, longName.length, `L`), padded(longName));
            blocks.push(header(entry.name.slice(0, 100), size, flag));
        } else if (entry.longName === `prefix`) {
            const cut = entry.name.lastIndexOf(`/`);
            blocks.push(header(entry.name.slice(cut + 1), size, flag, entry.name.slice(0, cut)));
        } else {
            blocks.push(header(entry.name, size, flag));
        }
        if (size > 0) {
            blocks.push(padded(body));
        }
    }
    blocks.push(Buffer.alloc(1024));
    return Buffer.concat(blocks);
};

export const tarGzOf = (entries: readonly TarFixtureEntry[]): Buffer => gzipSync(tarOf(entries));

// `bytes` as a chunk stream of `size`-byte pieces, the way a socket delivers them.
export async function* chunked(bytes: Buffer, size: number): AsyncGenerator<Buffer> {
    for (let at = 0; at < bytes.length; at += size) {
        yield bytes.subarray(at, at + size);
    }
}
