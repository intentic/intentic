import { parseXwdHeader, readFramebufferMarker } from "./framebuffer.js";
import { MARKER, paintMarker } from "./marker.js";

// Xvfb's -fbdir file as Xvfb 21 writes it for a 640x480x24 screen (read off a real one, 2026-11-19): the header's
// fields, where the pixels start, and the marker read back out of them.

// The 25 header fields, big-endian, as that screen's file holds them.
const XVFB_640X480 = [160, 7, 2, 24, 640, 480, 0, 0, 32, 0, 32, 32, 2560, 4, 0xff0000, 0xff00, 0xff, 8, 256, 256, 640, 480, 0, 0, 0];

const fileWith = (fields: readonly number[]): Uint8Array => {
    const layoutBytes = fields[0]! + fields[19]! * 12 + fields[12]! * fields[5]!;
    const file = new Uint8Array(layoutBytes);
    const view = new DataView(file.buffer);
    fields.forEach((value, index) => view.setUint32(index * 4, value));
    return file;
};

describe("parseXwdHeader", () => {
    it("finds the pixels past the header and its 256-entry colour map, with green the second byte of each pixel", () => {
        expect(parseXwdHeader(fileWith(XVFB_640X480))).toEqual({ width: 640, height: 480, bytesPerLine: 2560, bitsPerPixel: 32, pixelOffset: 3232, greenOffset: 1 });
    });

    it("refuses a framebuffer that is not 32 bits a pixel", () => {
        const sixteen = [...XVFB_640X480];
        sixteen[11] = 16;
        expect(() => parseXwdHeader(fileWith(sixteen))).toThrow("castbench reads a 32-bit framebuffer, and this one is 16-bit");
    });
});

describe("readFramebufferMarker", () => {
    it("reads a marker painted into the framebuffer's pixels at a screen position", () => {
        const file = fileWith(XVFB_640X480);
        const layout = parseXwdHeader(file);
        const at = { x: 100 + MARKER.x, y: 50 + MARKER.y };
        paintMarker(
            (x, y, size, white) => {
                for (let row = y; row < y + size; row++) {
                    for (let column = x; column < x + size; column++) {
                        file.fill(white ? 255 : 0, layout.pixelOffset + row * layout.bytesPerLine + column * 4, layout.pixelOffset + row * layout.bytesPerLine + column * 4 + 3);
                    }
                }
            },
            { frame: 321, ms: 654_321 },
            at.x,
            at.y,
        );
        expect(readFramebufferMarker(file, layout, at.x, at.y)).toEqual({ frame: 321, ms: 654_321 });
    });
});
