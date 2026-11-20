import { deflateSync } from "node:zlib";

// A tab's icon as the editor draws it: a small data: URL the daemon built from bytes it fetched itself, so the person's
// own browser never asks a third-party origin for anything. What a site serves is anything from a 70-byte PNG to a
// 100 KB .ico holding every size from 16 to 256 pixels; the strip draws 16 CSS pixels, so a multi-size .ico gives up its
// 32-pixel picture (the strip's 16 at twice the density), and anything still over the cap is no icon at all rather than
// a window state that grows by a hundred kilobytes a tab.

// The most an icon's own bytes may weigh once picked out; its data: URL is a third longer. A 32-pixel PNG is one or two
// kilobytes, so this turns away only the icons a site never meant for a tab (a 192-pixel PNG named as its icon).
export const FAVICON_MAX_BYTES = 4096;

// The size picked out of a multi-size .ico: the strip's 16 CSS pixels at a 2x display.
const WANTED_PX = 32;

type ImageKind = "png" | "gif" | "jpeg" | "webp" | "ico" | "bmp" | "svg";

const MIME = {
    png: "image/png",
    gif: "image/gif",
    jpeg: "image/jpeg",
    webp: "image/webp",
    svg: "image/svg+xml",
} as const satisfies Record<Exclude<ImageKind, "ico" | "bmp">, string>;

const startsWith = (bytes: Uint8Array, prefix: readonly number[], at = 0): boolean => prefix.every((byte, index) => bytes[at + index] === byte);

// What the bytes are, read off their own first bytes: a server's Content-Type for /favicon.ico is as often text/html
// (its 404 page) or application/octet-stream as it is right.
export const sniffImage = (bytes: Uint8Array): ImageKind | undefined => {
    if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47])) {
        return "png";
    }
    if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) {
        return "gif";
    }
    if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
        return "jpeg";
    }
    if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) {
        return "webp";
    }
    if (startsWith(bytes, [0, 0, 1, 0]) && bytes.length >= 6) {
        return "ico";
    }
    if (startsWith(bytes, [0x42, 0x4d])) {
        return "bmp";
    }
    // An SVG is text: skip a byte-order mark and whitespace, then an XML declaration or a comment may lead the <svg.
    const head = new TextDecoder().decode(bytes.subarray(0, 512)).replace(/^﻿/, "").trimStart();
    return /^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(head) ? "svg" : undefined;
};

// ===== PNG out =====

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    return c >>> 0;
});

const crc32 = (bytes: Uint8Array): number => {
    let crc = 0xffffffff;
    for (const byte of bytes) {
        crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
};

const chunk = (type: string, data: Uint8Array): Buffer => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
};

// RGBA pixels, top row first, as a PNG: no filter on any row, which a 32-pixel icon does not need to stay small.
export const encodePng = (width: number, height: number, rgba: Uint8Array): Buffer => {
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header.set([8, 6, 0, 0, 0], 8);
    const rows = Buffer.alloc(height * (width * 4 + 1));
    for (let y = 0; y < height; y++) {
        rows.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
    }
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk("IHDR", header),
        chunk("IDAT", deflateSync(rows)),
        chunk("IEND", new Uint8Array()),
    ]);
};

// ===== .ico in =====

interface IcoEntry {
    readonly size: number;
    readonly bits: number;
    readonly offset: number;
    readonly length: number;
}

// The directory of a .ico: one entry per picture it holds. Undefined for one whose directory runs past its own bytes.
const icoEntries = (bytes: Buffer): IcoEntry[] | undefined => {
    const count = bytes.readUInt16LE(4);
    if (bytes.length < 6 + count * 16) {
        return undefined;
    }
    return Array.from({ length: count }, (_, index) => {
        const at = 6 + index * 16;
        return {
            size: bytes.readUInt8(at) === 0 ? 256 : bytes.readUInt8(at),
            bits: bytes.readUInt16LE(at + 6),
            offset: bytes.readUInt32LE(at + 12),
            length: bytes.readUInt32LE(at + 8),
        };
    }).filter((entry) => entry.offset + entry.length <= bytes.length && entry.length > 0);
};

// The picture a tab draws best: the wanted size, else the smallest larger one, else the largest smaller; the most colours
// among equals.
export const pickIcoEntry = <E extends { readonly size: number; readonly bits: number }>(entries: readonly E[]): E | undefined =>
    entries.toSorted((left, right) => {
        const rank = (entry: E): number => (entry.size >= WANTED_PX ? entry.size - WANTED_PX : 1000 + WANTED_PX - entry.size);
        return rank(left) - rank(right) || right.bits - left.bits;
    })[0];

// The palette a ≤8-bit picture indexes, as RGB triples.
const paletteOf = (dib: Buffer, headerSize: number, bits: number): number[][] => {
    const used = dib.readUInt32LE(32);
    const colours = used === 0 ? 2 ** bits : used;
    return Array.from({ length: colours }, (_, index) => {
        const at = headerSize + index * 4;
        return at + 3 < dib.length ? [dib.readUInt8(at + 2), dib.readUInt8(at + 1), dib.readUInt8(at)] : [0, 0, 0];
    });
};

// One pixel's colour index in a row of a ≤8-bit picture.
const indexAt = (dib: Buffer, rowStart: number, x: number, bits: number): number => {
    const bit = x * bits;
    const byte = dib.readUInt8(rowStart + (bit >> 3));
    return (byte >> (8 - bits - (bit & 7))) & ((1 << bits) - 1);
};

// Where a bitmap picture's parts lie: its colours, then its one-bit mask, each row padded to four bytes, bottom row first.
interface DibLayout {
    readonly width: number;
    readonly height: number;
    readonly bits: number;
    readonly palette: readonly (readonly number[])[];
    readonly pixelsAt: number;
    readonly stride: number;
    readonly maskAt: number;
    readonly maskStride: number;
    readonly hasMask: boolean;
}

const dibLayout = (dib: Buffer): DibLayout | undefined => {
    if (dib.length < 40) {
        return undefined;
    }
    const headerSize = dib.readUInt32LE(0);
    const width = dib.readInt32LE(4);
    const height = Math.abs(dib.readInt32LE(8)) / 2;
    const bits = dib.readUInt16LE(14);
    const readable = dib.readUInt32LE(16) === 0 && [1, 4, 8, 24, 32].includes(bits);
    if (!readable || width <= 0 || height <= 0 || width > 256 || height > 256) {
        return undefined;
    }
    const palette = bits <= 8 ? paletteOf(dib, headerSize, bits) : [];
    const pixelsAt = headerSize + palette.length * 4;
    const stride = Math.ceil((width * bits) / 32) * 4;
    const maskAt = pixelsAt + stride * height;
    const maskStride = Math.ceil(width / 32) * 4;
    if (maskAt > dib.length) {
        return undefined;
    }
    return { width, height, bits, palette, pixelsAt, stride, maskAt, maskStride, hasMask: maskAt + maskStride * height <= dib.length };
};

// One pixel's colour and its own alpha (opaque for a picture with no alpha of its own).
const pixelAt = (dib: Buffer, layout: DibLayout, x: number, y: number): readonly number[] => {
    const row = layout.pixelsAt + (layout.height - 1 - y) * layout.stride;
    if (layout.bits < 24) {
        const [r = 0, g = 0, b = 0] = layout.palette[indexAt(dib, row, x, layout.bits)] ?? [];
        return [r, g, b, 255];
    }
    const at = row + x * (layout.bits / 8);
    return [dib.readUInt8(at + 2), dib.readUInt8(at + 1), dib.readUInt8(at), layout.bits === 32 ? dib.readUInt8(at + 3) : 255];
};

const maskedAt = (dib: Buffer, layout: DibLayout, x: number, y: number): boolean =>
    layout.hasMask && indexAt(dib, layout.maskAt + (layout.height - 1 - y) * layout.maskStride, x, 1) === 1;

// A .ico's bitmap picture (a BITMAPINFOHEADER with no file header, twice its own height: the colours, then a one-bit
// transparency mask) as RGBA, top row first. 32-bit, 24-bit and paletted pictures, uncompressed; anything else is
// undefined, which is no icon. A 32-bit picture says what is see-through in its own alpha, unless its alpha is all zero,
// which is one drawn for the mask alone.
export const dibToRgba = (dib: Buffer): { width: number; height: number; rgba: Uint8Array } | undefined => {
    const layout = dibLayout(dib);
    if (layout === undefined) {
        return undefined;
    }
    const { width, height } = layout;
    const rgba = new Uint8Array(width * height * 4);
    for (let index = 0; index < width * height; index++) {
        rgba.set(pixelAt(dib, layout, index % width, Math.floor(index / width)), index * 4);
    }
    const ownAlpha = layout.bits === 32 && rgba.some((value, index) => index % 4 === 3 && value !== 0);
    if (!ownAlpha) {
        for (let index = 0; index < width * height; index++) {
            rgba[index * 4 + 3] = maskedAt(dib, layout, index % width, Math.floor(index / width)) ? 0 : 255;
        }
    }
    return { width, height, rgba };
};

// The picture a .ico holds for a tab, as PNG bytes: a PNG it embeds as it is, a bitmap one encoded.
const icoToPng = (bytes: Buffer): Buffer | undefined => {
    const picked = pickIcoEntry(icoEntries(bytes) ?? []);
    if (picked === undefined) {
        return undefined;
    }
    const image = bytes.subarray(picked.offset, picked.offset + picked.length);
    if (sniffImage(image) === "png") {
        return image;
    }
    const decoded = dibToRgba(image);
    return decoded === undefined ? undefined : encodePng(decoded.width, decoded.height, decoded.rgba);
};

// What the editor draws for a tab, from the bytes its icon's address answered: a data: URL within the cap, or
// undefined for something that is no image, an image this cannot read, or one too large to send.
export const iconDataUrl = (raw: Uint8Array, maxBytes: number = FAVICON_MAX_BYTES): string | undefined => {
    const bytes = Buffer.from(raw);
    const kind = sniffImage(bytes);
    if (kind === undefined || kind === "bmp") {
        return undefined;
    }
    const image = kind === "ico" ? icoToPng(bytes) : bytes;
    const mime = kind === "ico" ? MIME.png : MIME[kind];
    if (image === undefined || image.length === 0 || image.length > maxBytes) {
        return undefined;
    }
    return `data:${mime};base64,${image.toString("base64")}`;
};

// ===== The cache =====

// How many icons are held: a person's day of browsing, each at most the cap.
const CACHE_ENTRIES = 256;
// How long "this address has no icon we can send" stands before it is asked again: a site that fixes its icon, or a
// fetch that failed on a flaky connection, gets another chance, but a page reloading every few seconds does not refetch.
const MISS_MS = 10 * 60_000;

interface Cached {
    readonly icon: string | undefined;
    readonly at: number;
}

// Icons by the address they were fetched from, which is in practice per site: every page of an origin names the same
// one. Least recently used goes first, and a known miss is held as one, so a site with no icon is not asked on every
// navigation. In-flight fetches of one address are shared.
export class FaviconCache {
    readonly #entries = new Map<string, Cached>();
    readonly #inflight = new Map<string, Promise<string | undefined>>();
    readonly #limit: number;
    readonly #now: () => number;

    constructor(limit: number = CACHE_ENTRIES, now: () => number = Date.now) {
        this.#limit = limit;
        this.#now = now;
    }

    // The icon for an address, fetching it once when it is not held (or its miss has gone stale).
    async get(url: string, fetchIcon: (url: string) => Promise<Uint8Array | undefined>): Promise<string | undefined> {
        const held = this.#entries.get(url);
        if (held !== undefined && (held.icon !== undefined || this.#now() - held.at < MISS_MS)) {
            // Re-inserted: the Map's order is the recency order.
            this.#entries.delete(url);
            this.#entries.set(url, held);
            return held.icon;
        }
        const inflight = this.#inflight.get(url);
        if (inflight !== undefined) {
            return inflight;
        }
        const fetching = fetchIcon(url)
            // allow(silent-catch): an icon that cannot be fetched is a tab drawn with its glyph, and held as a miss.
            .catch(() => undefined)
            .then((bytes) => {
                const icon = bytes === undefined ? undefined : iconDataUrl(bytes);
                this.#set(url, icon);
                return icon;
            })
            .finally(() => this.#inflight.delete(url));
        this.#inflight.set(url, fetching);
        return fetching;
    }

    get size(): number {
        return this.#entries.size;
    }

    #set(url: string, icon: string | undefined): void {
        this.#entries.delete(url);
        this.#entries.set(url, { icon, at: this.#now() });
        while (this.#entries.size > this.#limit) {
            const oldest = this.#entries.keys().next().value;
            if (oldest === undefined) {
                break;
            }
            this.#entries.delete(oldest);
        }
    }
}
