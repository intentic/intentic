// The marker a workload page paints into its own content and the client reads back off decoded pixels: which frame it
// was and when it was drawn, so latency and unique frames are measured on the picture itself rather than on the wire.
// voxl's bench method (bench/loadgen.c, bench/nclient.py): black and white blocks read at their centres, which survive
// any codec setting a person would watch. Over voxl's 40 bits it adds a check byte, because x11grab can catch a canvas
// half-written, and a torn read must not count as a latency.
//
// DOM-free on purpose: the workload pages paint it, the decoder page reads it and the tests run it, all from this file.

// Where the marker sits in the page's viewport and how it is cut, in CSS px (the stage runs at one device pixel per CSS
// pixel). The origin and the block are multiples of 16, so every block fills whole H.264 macroblocks and keeps its
// colour clean at any rate the encoder picks.
export const MARKER = { x: 16, y: 16, block: 16, columns: 24, rows: 2 } as const;
export const MARKER_WIDTH = MARKER.block * MARKER.columns;
export const MARKER_HEIGHT = MARKER.block * MARKER.rows;

const FRAME_BITS = 16;
const MS_BITS = 24;
const CHECK_BITS = 8;
export const MARKER_BITS = FRAME_BITS + MS_BITS + CHECK_BITS;

// The 24-bit millisecond clock the marker carries: the low bits of the epoch, which every process on one machine reads
// alike. It wraps every 4.7 hours, so a latency is read modulo it (latencyMs).
const MS_MODULUS = 2 ** MS_BITS;
const FRAME_MODULUS = 2 ** FRAME_BITS;

export interface MarkerValue {
    // The page's frame counter, or for the typing page the length of what was typed, modulo 2^16.
    readonly frame: number;
    // When the page drew it, as markerClock read it then.
    readonly ms: number;
}

export const markerClock = (epochMs: number): number => Math.floor(epochMs) % MS_MODULUS;

// CRC-8/SMBUS: polynomial 0x07, no reflection, zero start.
export const crc8 = (bytes: Iterable<number>): number => {
    let crc = 0;
    for (const byte of bytes) {
        crc ^= byte & 0xff;
        for (let bit = 0; bit < 8; bit++) {
            crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
        }
    }
    return crc;
};

// The check byte: CRC-8 over the five value bytes. A torn read flips some blocks and not others, which this sees.
export const markerCheck = (frame: number, ms: number): number => crc8([frame >> 8, frame & 0xff, ms >> 16, (ms >> 8) & 0xff, ms & 0xff]);

const bitsOf = (value: number, count: number): boolean[] => Array.from({ length: count }, (_, index) => ((value >> (count - 1 - index)) & 1) === 1);

// The marker's blocks in reading order (row by row, left to right), white for a set bit: frame, ms, check, each most
// significant bit first.
export const markerBits = (value: MarkerValue): boolean[] => {
    const frame = ((value.frame % FRAME_MODULUS) + FRAME_MODULUS) % FRAME_MODULUS;
    const ms = ((value.ms % MS_MODULUS) + MS_MODULUS) % MS_MODULUS;
    return [...bitsOf(frame, FRAME_BITS), ...bitsOf(ms, MS_BITS), ...bitsOf(markerCheck(frame, ms), CHECK_BITS)];
};

// Paints the marker through `fill`, one call per block with its top-left corner and whether it is white, the corner of
// the whole marker at (x, y). A callback rather than a canvas so this file needs no DOM types.
export const paintMarker = (fill: (x: number, y: number, size: number, white: boolean) => void, value: MarkerValue, x = 0, y = 0): void => {
    markerBits(value).forEach((bit, index) => {
        const column = index % MARKER.columns;
        const row = Math.floor(index / MARKER.columns);
        fill(x + column * MARKER.block, y + row * MARKER.block, MARKER.block, bit);
    });
};

const fromBits = (bits: readonly boolean[]): number => bits.reduce((value, bit) => value * 2 + (bit ? 1 : 0), 0);

// Brightness above this is a set bit: the codec keeps black and white far apart from it.
const THRESHOLD = 128;

// Reads a marker through `luma`, the brightness (0-255) at a point given in marker pixels from its top-left corner.
// Undefined when the check byte disagrees: a torn capture, or something drawn over the marker.
export const readMarker = (luma: (x: number, y: number) => number): MarkerValue | undefined => {
    const half = MARKER.block / 2;
    const bits = Array.from({ length: MARKER_BITS }, (_, index) => {
        const column = index % MARKER.columns;
        const row = Math.floor(index / MARKER.columns);
        return luma(column * MARKER.block + half, row * MARKER.block + half) > THRESHOLD;
    });
    const frame = fromBits(bits.slice(0, FRAME_BITS));
    const ms = fromBits(bits.slice(FRAME_BITS, FRAME_BITS + MS_BITS));
    const check = fromBits(bits.slice(FRAME_BITS + MS_BITS));
    return check === markerCheck(frame, ms) ? { frame, ms } : undefined;
};

// Reads a marker off one 8-bit plane (a decoded frame's Y plane, or a grey copy of a framebuffer), `stride` bytes a row,
// with the marker's corner at (x, y) in it.
export const readMarkerPlane = (plane: Uint8Array, stride: number, x = 0, y = 0): MarkerValue | undefined =>
    readMarker((dx, dy) => plane[(y + dy) * stride + x + dx] ?? 0);

// How long ago the marker was drawn, in ms, as seen at `epochMs`: the clock's wrap undone, valid for any latency under
// half the wrap (2.3 hours), far past anything a stream that works would show.
export const latencyMs = (drawnMs: number, epochMs: number): number => {
    const raw = (markerClock(epochMs) - drawnMs) % MS_MODULUS;
    if (raw > MS_MODULUS / 2) {
        return raw - MS_MODULUS;
    }
    return raw < -MS_MODULUS / 2 ? raw + MS_MODULUS : raw;
};

// How many frames `later` is past `earlier` on the 16-bit counter, wrap undone; negative for one that went backwards.
export const frameDelta = (earlier: number, later: number): number => {
    const raw = (later - earlier) % FRAME_MODULUS;
    if (raw >= FRAME_MODULUS / 2) {
        return raw - FRAME_MODULUS;
    }
    return raw < -FRAME_MODULUS / 2 ? raw + FRAME_MODULUS : raw;
};
