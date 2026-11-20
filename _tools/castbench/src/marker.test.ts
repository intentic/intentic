import {
    crc8,
    frameDelta,
    latencyMs,
    MARKER,
    MARKER_BITS,
    MARKER_HEIGHT,
    MARKER_WIDTH,
    markerBits,
    markerCheck,
    markerClock,
    paintMarker,
    readMarker,
    readMarkerPlane,
} from "./marker.js";

// The marker round trip: what a page paints is what the decoder reads, a torn read is refused, and the clock's wrap
// never turns into a negative or a 16-second latency.

// A grey plane the marker is painted into, as a decoded frame's Y plane holds it.
const planeWith = (value: { frame: number; ms: number }, width = MARKER_WIDTH + 40, height = MARKER_HEIGHT + 40, at = { x: 20, y: 20 }) => {
    const plane = new Uint8Array(width * height).fill(90);
    const fill = (x: number, y: number, size: number, white: boolean) => {
        for (let row = y; row < y + size; row++) {
            plane.fill(white ? 235 : 16, row * width + x, row * width + x + size);
        }
    };
    paintMarker(fill, value, at.x, at.y);
    return { plane, stride: width, at };
};

describe("the marker's layout", () => {
    it("is 24 columns by 2 rows of 16 px blocks starting at (16, 16), one block per bit", () => {
        expect(MARKER).toEqual({ x: 16, y: 16, block: 16, columns: 24, rows: 2 });
        expect([MARKER_WIDTH, MARKER_HEIGHT, MARKER_BITS]).toEqual([384, 32, 48]);
    });

    it("spells frame, then ms, then the check byte, most significant bit first", () => {
        const bits = markerBits({ frame: 0x8001, ms: 0x800001 });
        expect(bits.slice(0, 16).map(Number).join("")).toBe("1000000000000001");
        expect(bits.slice(16, 40).map(Number).join("")).toBe("100000000000000000000001");
        expect(
            bits
                .slice(40)
                .map(Number)
                .join(""),
        ).toBe(markerCheck(0x8001, 0x800001).toString(2).padStart(8, "0"));
    });

    it("takes the frame modulo 2^16 and the ms modulo 2^24", () => {
        expect(markerBits({ frame: 0x10005, ms: 0x1000007 })).toEqual(markerBits({ frame: 5, ms: 7 }));
    });
});

describe("the check byte", () => {
    it("is CRC-8/SMBUS, whose catalogued check value over the ASCII digits 1-9 is 0xF4", () => {
        expect(crc8(new TextEncoder().encode("123456789"))).toBe(0xf4);
    });

    it("covers frame and ms as five big-endian bytes", () => {
        expect(markerCheck(0x1234, 0x56789a)).toBe(crc8([0x12, 0x34, 0x56, 0x78, 0x9a]));
        expect(markerCheck(0, 0)).toBe(0);
    });
});

describe("reading a marker back", () => {
    it("reads what was painted, off a plane with the marker anywhere in it", () => {
        const { plane, stride, at } = planeWith({ frame: 4242, ms: 12_345_678 });
        expect(readMarkerPlane(plane, stride, at.x, at.y)).toEqual({ frame: 4242, ms: 12_345_678 });
    });

    it("refuses a read whose blocks disagree with the check byte, as a torn capture gives", () => {
        const { plane, stride, at } = planeWith({ frame: 7, ms: 1000 });
        // Flips the first ms block's centre: frame and ms still parse, the check no longer matches.
        const centre = (at.y + MARKER.block / 2) * stride + at.x + 16 * MARKER.block + MARKER.block / 2;
        plane[centre] = plane[centre]! > 128 ? 16 : 235;
        expect(readMarkerPlane(plane, stride, at.x, at.y)).toBeUndefined();
    });

    it("thresholds at 128, so a codec's drift around black and white does not move a bit", () => {
        const value = { frame: 0xa5a5, ms: 0x5a5a5a };
        const bits = markerBits(value);
        const read = readMarker((x, y) => {
            const index = Math.floor(y / MARKER.block) * MARKER.columns + Math.floor(x / MARKER.block);
            return bits[index] ? 129 : 128;
        });
        expect(read).toEqual(value);
    });
});

describe("latency off the 24-bit clock", () => {
    it("is the plain difference away from the wrap", () => {
        const now = 1_790_000_000_123;
        expect(latencyMs(markerClock(now - 37), now)).toBe(37);
    });

    it("stays right across the wrap, either way round", () => {
        const wrap = 2 ** 24;
        // Drawn just before the clock wrapped, seen just after.
        expect(latencyMs(wrap - 5, wrap * 1000 + 20)).toBe(25);
        // A marker from slightly in the future (two processes reading the clock a hair apart) reads negative, not 16 s.
        expect(latencyMs(3, wrap * 1000 + wrap - 2)).toBe(-5);
    });
});

describe("frame counting off the 16-bit counter", () => {
    it("counts forward across the wrap and backward as negative", () => {
        expect(frameDelta(65_534, 1)).toBe(3);
        expect(frameDelta(10, 7)).toBe(-3);
        expect(frameDelta(5, 5)).toBe(0);
    });
});
