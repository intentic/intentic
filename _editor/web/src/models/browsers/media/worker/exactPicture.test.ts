// An exact picture's drawing, on a fake painter: a clipped frame's stripe drawn only where it meets the clip, at the
// same place in the picture it would take whole, and castd's exact pixels drawn as a VideoFrame of their own or, where
// the browser makes none, as ImageData turned from B, G, R, unused to R, G, B, A.
import type { Drawable, FrameLike, Painter, PixelsLike } from "./decodeSeams";
import { bgrxToRgba, paintExact, stripePainter, stripePart } from "./exactPicture";
import type { ExactCopy } from "../mediaHeader";

// A stripe 1000 px wide and 100 rows tall, at row 200 of the picture.
const TOP = 200;
const WIDTH = 1000;
const HEIGHT = 100;

it("copies the rows of a clip that fall in the stripe, from the stripe's own rows to the picture's", () => {
    expect(stripePart({ x: 10, y: 220, width: 30, height: 40 }, TOP, WIDTH, HEIGHT)).toEqual({ sx: 10, sy: 20, dx: 10, dy: 220, width: 30, height: 40 });
});

it("copies only the stripe's share of a clip that starts above it or runs on below it", () => {
    // From row 150 to 250: the stripe's rows 200..250.
    expect(stripePart({ x: 0, y: 150, width: 50, height: 100 }, TOP, WIDTH, HEIGHT)).toEqual({ sx: 0, sy: 0, dx: 0, dy: 200, width: 50, height: 50 });
    // From row 290 to 400: the stripe's last ten rows.
    expect(stripePart({ x: 5, y: 290, width: 20, height: 110 }, TOP, WIDTH, HEIGHT)).toEqual({ sx: 5, sy: 90, dx: 5, dy: 290, width: 20, height: 10 });
    // Over the whole stripe and past its right edge.
    expect(stripePart({ x: 900, y: 0, width: 400, height: 1600 }, TOP, WIDTH, HEIGHT)).toEqual({ sx: 900, sy: 0, dx: 900, dy: 200, width: 100, height: 100 });
});

it("copies nothing of a clip that misses the stripe, touches only its edge, or is empty", () => {
    expect(stripePart({ x: 0, y: 0, width: 50, height: 200 }, TOP, WIDTH, HEIGHT)).toBeUndefined();
    expect(stripePart({ x: 0, y: 300, width: 50, height: 10 }, TOP, WIDTH, HEIGHT)).toBeUndefined();
    expect(stripePart({ x: 10, y: 220, width: 0, height: 40 }, TOP, WIDTH, HEIGHT)).toBeUndefined();
    expect(stripePart({ x: 10, y: 220, width: 30, height: 0 }, TOP, WIDTH, HEIGHT)).toBeUndefined();
    expect(stripePart({ x: 0, y: 0, width: 0, height: 0 }, TOP, WIDTH, HEIGHT)).toBeUndefined();
});

interface Drawn {
    readonly image: Drawable | PixelsLike;
    readonly at: readonly number[];
}

const recorder = () => {
    const drawn: Drawn[] = [];
    const painter: Painter = {
        drawImage: (image: Drawable, ...at: number[]) => drawn.push({ image, at }),
        putImageData: (image: PixelsLike, ...at: number[]) => drawn.push({ image, at }),
    };
    return { drawn, painter };
};

const stripe: FrameLike = { timestamp: 1, displayWidth: WIDTH, displayHeight: HEIGHT, close: () => undefined };

it("draws an unclipped stripe whole at its top row, a clipped one only inside its clip, and a missed one not at all", () => {
    const { drawn, painter } = recorder();
    stripePainter({ frame: stripe, top: TOP, captureMs: 0 })?.(painter);
    stripePainter({ frame: stripe, top: TOP, captureMs: 0, clip: { x: 10, y: 150, width: 30, height: 100 } })?.(painter);
    expect(stripePainter({ frame: stripe, top: TOP, captureMs: 0, clip: { x: 0, y: 0, width: 0, height: 0 } })).toBeUndefined();
    expect(drawn).toEqual([
        { image: stripe, at: [0, 200] },
        { image: stripe, at: [10, 0, 30, 50, 10, 200, 30, 50] },
    ]);
});

it("turns castd's B, G, R, unused into R, G, B and an opaque alpha", () => {
    expect([...bgrxToRgba(new Uint8Array([1, 2, 3, 0, 10, 20, 30, 99]))]).toEqual([3, 2, 1, 255, 30, 20, 10, 255]);
});

// Two by one pixels at (40, 50): blue, then red.
const copy: ExactCopy = { rect: { x: 40, y: 50, width: 2, height: 1 }, pixels: new Uint8Array([255, 0, 0, 0, 0, 0, 255, 0]) };

it("draws an exact copy as a VideoFrame of castd's own pixels where the browser makes one, and lets the frame go", () => {
    const { drawn, painter } = recorder();
    const made: { pixels: Uint8Array; width: number; height: number; closed: boolean }[] = [];
    paintExact(painter, copy, {
        bgrxFrame: (pixels, width, height) => {
            const frame = { pixels, width, height, closed: false };
            made.push(frame);
            return { timestamp: 0, displayWidth: width, displayHeight: height, close: () => (frame.closed = true) };
        },
        imageData: () => {
            throw new Error(`not wanted where a VideoFrame is made`);
        },
    });
    expect(made).toEqual([{ pixels: copy.pixels, width: 2, height: 1, closed: true }]);
    expect(drawn.map((draw) => draw.at)).toEqual([[40, 50]]);
});

it("puts an exact copy as RGBA ImageData where the browser makes no BGRX VideoFrame", () => {
    const { drawn, painter } = recorder();
    paintExact(painter, copy, {
        bgrxFrame: () => {
            throw new TypeError(`Unsupported format`);
        },
        imageData: (data, width, height) => ({ data, width, height }),
    });
    expect(drawn).toEqual([{ image: { data: new Uint8ClampedArray([0, 0, 255, 255, 255, 0, 0, 255]), width: 2, height: 1 }, at: [40, 50] }]);
});

it("draws nothing for an empty copy", () => {
    const { drawn, painter } = recorder();
    paintExact(painter, { rect: { x: 1, y: 1, width: 0, height: 4 }, pixels: new Uint8Array() }, {
        bgrxFrame: () => {
            throw new Error(`nothing to make`);
        },
        imageData: () => {
            throw new Error(`nothing to make`);
        },
    });
    expect(drawn).toEqual([]);
});
