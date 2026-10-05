import { deflateSync, inflateSync } from "node:zlib";
import { DesktopError, type Rect } from "./types.js";

/* PNG in and out with nothing but node:zlib, because this package ships inside a single-file binary that no
   native image library loads into. Enough of the format for what screenshot tools write: every colour type, bit
   depths 1–16, no interlacing. Pixels are held as 8-bit RGB: a screen has no transparency worth keeping. */

export interface Pixels {
    readonly width: number;
    readonly height: number;
    // Interleaved RGB, three bytes per pixel, rows top to bottom.
    readonly data: Uint8Array;
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Samples per pixel for each colour type: grey, RGB, palette index, grey+alpha, RGBA.
const CHANNELS = new Map([
    [0, 1],
    [2, 3],
    [3, 1],
    [4, 2],
    [6, 4],
]);

interface Header {
    readonly width: number;
    readonly height: number;
    readonly depth: number;
    readonly colour: number;
}

// The chunks that carry pixels, gathered in one pass; the rest (text, gamma, timestamps) are skipped.
const readChunks = (png: Buffer) => {
    if (png.length < 33 || !png.subarray(0, 8).equals(SIGNATURE)) {
        throw new DesktopError("That is not a PNG.");
    }
    let header: Header | undefined;
    let palette: Buffer | undefined;
    const parts: Buffer[] = [];
    for (let at = 8; at + 8 <= png.length; ) {
        const length = png.readUInt32BE(at);
        const type = png.toString("latin1", at + 4, at + 8);
        const body = png.subarray(at + 8, at + 8 + length);
        if (type === "IHDR") {
            if (body[12] !== 0) {
                throw new DesktopError("This PNG is interlaced, which the screen reader here does not decode.");
            }
            header = { width: body.readUInt32BE(0), height: body.readUInt32BE(4), depth: body[8] ?? 0, colour: body[9] ?? 0 };
        } else if (type === "PLTE") {
            palette = body;
        } else if (type === "IDAT") {
            parts.push(body);
        } else if (type === "IEND") {
            break;
        }
        at += 12 + length;
    }
    if (header === undefined || !CHANNELS.has(header.colour) || ![1, 2, 4, 8, 16].includes(header.depth)) {
        throw new DesktopError("This PNG has a layout the screen reader here does not decode.");
    }
    return { header, palette, data: Buffer.concat(parts) };
};

const paeth = (left: number, up: number, upLeft: number): number => {
    const estimate = left + up - upLeft;
    const toLeft = Math.abs(estimate - left);
    const toUp = Math.abs(estimate - up);
    const toUpLeft = Math.abs(estimate - upLeft);
    if (toLeft <= toUp && toLeft <= toUpLeft) {
        return left;
    }
    return toUp <= toUpLeft ? up : upLeft;
};

// One row's filter undone in place: `data` holds every row, each after its filter byte, and the row above (at
// `previous`, or -1 for none) has already been undone. One function per filter, each a single loop, since these run
// once per byte of a 4K screen.
interface Row {
    readonly data: Uint8Array;
    readonly start: number;
    readonly previous: number;
    readonly stride: number;
    readonly bpp: number;
}

const unSub = ({ data, start, stride, bpp }: Row): void => {
    for (let index = start + bpp; index < start + stride; index++) {
        data[index] = ((data[index] ?? 0) + (data[index - bpp] ?? 0)) & 0xff;
    }
};

const unUp = ({ data, start, previous, stride }: Row): void => {
    if (previous < 0) {
        return;
    }
    for (let index = 0; index < stride; index++) {
        data[start + index] = ((data[start + index] ?? 0) + (data[previous + index] ?? 0)) & 0xff;
    }
};

const unAverage = ({ data, start, previous, stride, bpp }: Row): void => {
    for (let index = 0; index < stride; index++) {
        const left = index >= bpp ? (data[start + index - bpp] ?? 0) : 0;
        const up = previous < 0 ? 0 : (data[previous + index] ?? 0);
        data[start + index] = ((data[start + index] ?? 0) + ((left + up) >> 1)) & 0xff;
    }
};

const unPaeth = ({ data, start, previous, stride, bpp }: Row): void => {
    const hasUp = previous >= 0;
    for (let index = 0; index < stride; index++) {
        const hasLeft = index >= bpp;
        const left = hasLeft ? (data[start + index - bpp] ?? 0) : 0;
        const up = hasUp ? (data[previous + index] ?? 0) : 0;
        const upLeft = hasLeft && hasUp ? (data[previous + index - bpp] ?? 0) : 0;
        data[start + index] = ((data[start + index] ?? 0) + paeth(left, up, upLeft)) & 0xff;
    }
};

const UNFILTER = [() => undefined, unSub, unUp, unAverage, unPaeth];

const unfilter = (row: Row): void => {
    const filter = row.data[row.start - 1] ?? 0;
    const undo = UNFILTER[filter];
    if (undo === undefined) {
        throw new DesktopError(`This PNG uses row filter ${filter}, which the format does not define.`);
    }
    undo(row);
};

// The sample at `index` of an unfiltered row starting at `start`, scaled to 8 bits. Sub-byte depths pack from the
// high bit down.
const sample = (data: Uint8Array, start: number, index: number, depth: number): number => {
    if (depth === 8) {
        return data[start + index] ?? 0;
    }
    if (depth === 16) {
        return data[start + index * 2] ?? 0;
    }
    const perByte = 8 / depth;
    const byte = data[start + Math.floor(index / perByte)] ?? 0;
    const value = (byte >> (8 - depth * ((index % perByte) + 1))) & ((1 << depth) - 1);
    return Math.round((value * 255) / ((1 << depth) - 1));
};

// A palette index is not scaled: it names an entry.
const paletteIndex = (data: Uint8Array, start: number, index: number, depth: number): number => {
    if (depth === 8) {
        return data[start + index] ?? 0;
    }
    const perByte = 8 / depth;
    const byte = data[start + Math.floor(index / perByte)] ?? 0;
    return (byte >> (8 - depth * ((index % perByte) + 1))) & ((1 << depth) - 1);
};

// One unfiltered row into RGB. The two layouts screenshot tools write (8-bit RGB, 8-bit RGBA) are copied straight;
// the rest go sample by sample.
const toRgb = (data: Uint8Array, start: number, out: Uint8Array, at: number, width: number, header: Header, palette: Buffer | undefined): void => {
    const { depth, colour } = header;
    if (depth === 8 && colour === 2) {
        out.set(data.subarray(start, start + width * 3), at);
        return;
    }
    if (depth === 8 && colour === 6) {
        for (let x = 0, from = start, to = at; x < width; x++, from += 4, to += 3) {
            out[to] = data[from] ?? 0;
            out[to + 1] = data[from + 1] ?? 0;
            out[to + 2] = data[from + 2] ?? 0;
        }
        return;
    }
    const channels = CHANNELS.get(colour) ?? 1;
    for (let x = 0, to = at; x < width; x++, to += 3) {
        if (colour === 3) {
            const entry = paletteIndex(data, start, x, depth) * 3;
            out[to] = palette?.[entry] ?? 0;
            out[to + 1] = palette?.[entry + 1] ?? 0;
            out[to + 2] = palette?.[entry + 2] ?? 0;
        } else if (colour === 0 || colour === 4) {
            const grey = sample(data, start, x * channels, depth);
            out[to] = grey;
            out[to + 1] = grey;
            out[to + 2] = grey;
        } else {
            out[to] = sample(data, start, x * channels, depth);
            out[to + 1] = sample(data, start, x * channels + 1, depth);
            out[to + 2] = sample(data, start, x * channels + 2, depth);
        }
    }
};

export const decodePng = (png: Buffer): Pixels => {
    const { header, palette, data } = readChunks(png);
    const { width, height, depth, colour } = header;
    const channels = CHANNELS.get(colour) ?? 1;
    const stride = Math.ceil((width * channels * depth) / 8);
    const bpp = Math.max(1, Math.ceil((channels * depth) / 8));
    const raw = new Uint8Array(inflateSync(data));
    if (raw.length < (stride + 1) * height) {
        throw new DesktopError("This PNG ends before its last row.");
    }
    const out = new Uint8Array(width * height * 3);
    for (let y = 0; y < height; y++) {
        const start = y * (stride + 1) + 1;
        unfilter({ data: raw, start, previous: y === 0 ? -1 : start - stride - 1, stride, bpp });
        toRgb(raw, start, out, y * width * 3, width, header, palette);
    }
    return { width, height, data: out };
};

const CRC_TABLE = ((): Uint32Array => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) {
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        }
        table[n] = c >>> 0;
    }
    return table;
})();

const crc32 = (bytes: Uint8Array): number => {
    let crc = 0xffffffff;
    for (const byte of bytes) {
        crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
};

const chunk = (type: string, body: Uint8Array): Buffer => {
    const out = Buffer.alloc(12 + body.length);
    out.writeUInt32BE(body.length, 0);
    out.write(type, 4, "latin1");
    out.set(body, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length);
    return out;
};

// The residual one filter leaves for the byte at `index` of a row (`left`, `up` and `upLeft` are its neighbours).
const residual = (filter: number, value: number, left: number, up: number, upLeft: number): number => {
    switch (filter) {
        case 1:
            return (value - left) & 0xff;
        case 2:
            return (value - up) & 0xff;
        case 3:
            return (value - ((left + up) >> 1)) & 0xff;
        case 4:
            return (value - paeth(left, up, upLeft)) & 0xff;
        default:
            return value;
    }
};

// The neighbours a filter predicts the byte at `index` of row `y` from.
const neighbours = (data: Uint8Array, row: number, previous: number, index: number, hasUp: boolean) => ({
    left: index >= 3 ? (data[row + index - 3] ?? 0) : 0,
    up: hasUp ? (data[previous + index] ?? 0) : 0,
    upLeft: hasUp && index >= 3 ? (data[previous + index - 3] ?? 0) : 0,
});

// The filter that leaves row `y` the smallest sum of signed bytes, the usual heuristic: it is what makes a screenshot of
// flat UI compress to a fraction of its raw size.
const bestFilter = (pixels: Pixels, y: number, scores: Float64Array): number => {
    const stride = pixels.width * 3;
    const row = y * stride;
    scores.fill(0);
    for (let index = 0; index < stride; index++) {
        const { left, up, upLeft } = neighbours(pixels.data, row, row - stride, index, y > 0);
        const value = pixels.data[row + index] ?? 0;
        for (let filter = 0; filter <= 4; filter++) {
            const r = residual(filter, value, left, up, upLeft);
            scores[filter] = (scores[filter] ?? 0) + (r < 128 ? r : 256 - r);
        }
    }
    let best = 0;
    for (let filter = 1; filter <= 4; filter++) {
        if ((scores[filter] ?? 0) < (scores[best] ?? 0)) {
            best = filter;
        }
    }
    return best;
};

// Every row, its filter byte first, filtered the way bestFilter chose.
const filterRows = (pixels: Pixels): Uint8Array => {
    const stride = pixels.width * 3;
    const out = new Uint8Array((stride + 1) * pixels.height);
    const scores = new Float64Array(5);
    for (let y = 0; y < pixels.height; y++) {
        const row = y * stride;
        const filter = bestFilter(pixels, y, scores);
        const into = y * (stride + 1);
        out[into] = filter;
        for (let index = 0; index < stride; index++) {
            const { left, up, upLeft } = neighbours(pixels.data, row, row - stride, index, y > 0);
            out[into + 1 + index] = residual(filter, pixels.data[row + index] ?? 0, left, up, upLeft);
        }
    }
    return out;
};

export const encodePng = (pixels: Pixels): Buffer => {
    const header = Buffer.alloc(13);
    header.writeUInt32BE(pixels.width, 0);
    header.writeUInt32BE(pixels.height, 4);
    header[8] = 8;
    header[9] = 2;
    return Buffer.concat([
        SIGNATURE,
        chunk("IHDR", header),
        chunk("IDAT", deflateSync(filterRows(pixels), { level: 6 })),
        chunk("IEND", new Uint8Array(0)),
    ]);
};

// The part of `pixels` inside `rect`, clipped to the image; a rect wholly outside it is refused.
export const crop = (pixels: Pixels, rect: Rect): Pixels => {
    const left = Math.max(0, Math.floor(rect.x));
    const top = Math.max(0, Math.floor(rect.y));
    const right = Math.min(pixels.width, Math.ceil(rect.x + rect.width));
    const bottom = Math.min(pixels.height, Math.ceil(rect.y + rect.height));
    if (right <= left || bottom <= top) {
        throw new DesktopError(`That region (${rect.x}, ${rect.y}, ${rect.width}×${rect.height}) is outside the screen.`);
    }
    if (left === 0 && top === 0 && right === pixels.width && bottom === pixels.height) {
        return pixels;
    }
    const width = right - left;
    const out = new Uint8Array(width * (bottom - top) * 3);
    for (let y = top; y < bottom; y++) {
        out.set(pixels.data.subarray((y * pixels.width + left) * 3, (y * pixels.width + right) * 3), (y - top) * width * 3);
    }
    return { width, height: bottom - top, data: out };
};

// For each destination index along one axis, the source pixels it covers and how much of each: an area average,
// which keeps thin text and one-pixel borders visible where nearest-neighbour or bilinear would drop them. Flat
// arrays rather than objects, since the passes below read them for every pixel.
interface Contributions {
    // Destination index i covers source pixels first[i] .. first[i] + count[i] - 1, weighted weights[offset[i] + k].
    readonly first: Int32Array;
    readonly count: Int32Array;
    readonly offset: Int32Array;
    readonly weights: Float32Array;
}

const contributions = (from: number, to: number): Contributions => {
    const ratio = from / to;
    const first = new Int32Array(to);
    const count = new Int32Array(to);
    const offset = new Int32Array(to);
    const weights = new Float32Array(to * (Math.ceil(ratio) + 2));
    let used = 0;
    for (let index = 0; index < to; index++) {
        const begin = index * ratio;
        const end = Math.min(from, begin + ratio);
        const start = Math.floor(begin);
        const stop = Math.ceil(end);
        first[index] = start;
        count[index] = stop - start;
        offset[index] = used;
        for (let source = start; source < stop; source++) {
            weights[used++] = (Math.min(end, source + 1) - Math.max(begin, source)) / ratio;
        }
    }
    return { first, count, offset, weights };
};

// The vertical pass, into floats: it shrinks the row count first, before the horizontal pass, which reads more
// weights per pixel, has to walk them.
const shrinkRows = (pixels: Pixels, down: Contributions, targetHeight: number): Float32Array => {
    const rowWidth = pixels.width * 3;
    const tall = new Float32Array(rowWidth * targetHeight);
    for (let y = 0; y < targetHeight; y++) {
        const from = down.first[y] ?? 0;
        const offset = down.offset[y] ?? 0;
        for (let k = 0; k < (down.count[y] ?? 0); k++) {
            const weight = down.weights[offset + k] ?? 0;
            const source = (from + k) * rowWidth;
            for (let x = 0; x < rowWidth; x++) {
                tall[y * rowWidth + x] = (tall[y * rowWidth + x] ?? 0) + (pixels.data[source + x] ?? 0) * weight;
            }
        }
    }
    return tall;
};

// One shrunk pixel of the horizontal pass, its three channels at `to` in `out`.
const shrinkPixel = (tall: Float32Array, row: number, across: Contributions, x: number, out: Uint8Array, to: number): void => {
    const from = across.first[x] ?? 0;
    const offset = across.offset[x] ?? 0;
    let red = 0;
    let green = 0;
    let blue = 0;
    for (let k = 0; k < (across.count[x] ?? 0); k++) {
        const weight = across.weights[offset + k] ?? 0;
        const at = row + (from + k) * 3;
        red += (tall[at] ?? 0) * weight;
        green += (tall[at + 1] ?? 0) * weight;
        blue += (tall[at + 2] ?? 0) * weight;
    }
    out[to] = red > 255 ? 255 : Math.round(red);
    out[to + 1] = green > 255 ? 255 : Math.round(green);
    out[to + 2] = blue > 255 ? 255 : Math.round(blue);
};

// Down to `width`×`height`, never up: a request at or above the source size answers the source.
export const downscale = (pixels: Pixels, width: number, height: number): Pixels => {
    if (width >= pixels.width && height >= pixels.height) {
        return pixels;
    }
    const targetWidth = Math.max(1, Math.min(width, pixels.width));
    const targetHeight = Math.max(1, Math.min(height, pixels.height));
    const across = contributions(pixels.width, targetWidth);
    const tall = shrinkRows(pixels, contributions(pixels.height, targetHeight), targetHeight);
    const out = new Uint8Array(targetWidth * targetHeight * 3);
    for (let y = 0; y < targetHeight; y++) {
        for (let x = 0; x < targetWidth; x++) {
            shrinkPixel(tall, y * pixels.width * 3, across, x, out, (y * targetWidth + x) * 3);
        }
    }
    return { width: targetWidth, height: targetHeight, data: out };
};
