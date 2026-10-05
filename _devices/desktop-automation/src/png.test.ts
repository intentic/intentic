import { deflateSync } from "node:zlib";
import { crop, decodePng, downscale, encodePng, type Pixels } from "./png.js";
import { DesktopError } from "./types.js";

/* The PNG reader and writer the screenshot path runs every frame through, against images built here byte by byte:
   what each screenshot tool writes differs (RGB, RGBA, a palette for a mostly flat screen), and each has to come
   out as the same pixels. */

const pixels = (width: number, height: number, at: (x: number, y: number) => readonly [number, number, number]): Pixels => {
    const data = new Uint8Array(width * height * 3);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            data.set(at(x, y), (y * width + x) * 3);
        }
    }
    return { width, height, data };
};

// A PNG with any colour type and bit depth, rows unfiltered: the layouts this package's own encoder never writes.
const rawPng = (width: number, height: number, colour: number, depth: number, rows: readonly number[][], palette?: readonly number[]): Buffer => {
    const chunk = (type: string, body: Buffer): Buffer => {
        const out = Buffer.alloc(12 + body.length);
        out.writeUInt32BE(body.length, 0);
        out.write(type, 4, "latin1");
        body.copy(out, 8);
        return out; // The reader does not check CRCs, so these are left zero.
    };
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header[8] = depth;
    header[9] = colour;
    const body = Buffer.concat(rows.map((row) => Buffer.from([0, ...row])));
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk("IHDR", header),
        ...(palette === undefined ? [] : [chunk("PLTE", Buffer.from(palette))]),
        chunk("IDAT", deflateSync(body)),
        chunk("IEND", Buffer.alloc(0)),
    ]);
};

test("what is written reads back pixel for pixel, whichever row filters the encoder chose", () => {
    // A gradient (Sub and Up win), flat bands (None), and noise (Paeth or anything): every filter gets exercised.
    let seed = 7;
    const noise = (): number => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % 256;
    const image = pixels(97, 41, (x, y) => (y < 10 ? [x * 2, y * 5, 100] : y < 20 ? [30, 30, 30] : [noise(), noise(), noise()]));
    const decoded = decodePng(encodePng(image));
    expect(decoded.width).toBe(97);
    expect(decoded.height).toBe(41);
    expect(Buffer.from(decoded.data).equals(Buffer.from(image.data))).toBe(true);
});

test("RGBA drops its alpha, grey spreads to three channels, and a sub-byte palette is looked up", () => {
    const rgba = decodePng(rawPng(2, 1, 6, 8, [[10, 20, 30, 0, 40, 50, 60, 255]]));
    expect([...rgba.data]).toEqual([10, 20, 30, 40, 50, 60]);
    const grey = decodePng(rawPng(2, 1, 0, 8, [[0, 200]]));
    expect([...grey.data]).toEqual([0, 0, 0, 200, 200, 200]);
    // Two bits per index, high bits first: 0b00_01_10_11 is indexes 0, 1, 2, 3.
    const palette = decodePng(rawPng(4, 1, 3, 2, [[0b00_01_10_11]], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]));
    expect([...palette.data]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    // A 16-bit sample keeps its high byte.
    const deep = decodePng(rawPng(1, 1, 2, 16, [[0xab, 0xcd, 0x12, 0x34, 0xff, 0x00]]));
    expect([...deep.data]).toEqual([0xab, 0x12, 0xff]);
});

test("what is not a PNG, or one this reader does not decode, is refused in words", () => {
    expect(() => decodePng(Buffer.from("not an image at all, just text"))).toThrow(DesktopError);
    const interlaced = rawPng(1, 1, 2, 8, [[1, 2, 3]]);
    interlaced[8 + 8 + 12] = 1;
    expect(() => decodePng(interlaced)).toThrow(/interlaced/);
});

test("shrinking averages the area each pixel covers, so a one-pixel line survives as a fainter one", () => {
    // A black image with one white column: nearest-neighbour could drop it entirely.
    const lined = pixels(8, 2, (x) => (x === 3 ? [255, 255, 255] : [0, 0, 0]));
    const half = downscale(lined, 4, 1);
    expect([half.width, half.height]).toEqual([4, 1]);
    expect([...half.data.subarray(3, 6)]).toEqual([128, 128, 128]);
    expect(half.data[0]).toBe(0);
    // A ratio that is not whole splits a pixel between two.
    const thirds = downscale(pixels(3, 1, (x) => [x * 90, 0, 0]), 2, 1);
    expect([thirds.data[0], thirds.data[3]]).toEqual([30, 150]);
});

test("nothing is enlarged, and a crop is clipped to the image", () => {
    const image = pixels(4, 4, (x, y) => [x, y, 0]);
    expect(downscale(image, 10, 10)).toBe(image);
    const corner = crop(image, { x: 2, y: 3, width: 5, height: 5 });
    expect([corner.width, corner.height]).toEqual([2, 1]);
    expect([...corner.data]).toEqual([2, 3, 0, 3, 3, 0]);
    expect(() => crop(image, { x: 9, y: 9, width: 2, height: 2 })).toThrow(/outside the screen/);
});
