import type { Quad } from "./geometry.js";
import { boxesFromMap, detectionInput, detectionSize, readingOrder } from "./text-detection.js";

// PP-OCRv6's detector around the model: the size it reads an image at and the boxes its probability map becomes,
// pinned to what PaddleOCR 3.7 (paddlex's DetResizeForTest and DBPostProcess) answers for the same input.

test("an image is read at its own size rounded to multiples of 32, halves to even, the long side capped at 4000", () => {
    expect(detectionSize(900, 520)).toEqual({ width: 896, height: 512 });
    // 1008 / 32 is 31.5, which Python rounds to 32.
    expect(detectionSize(1000, 1008)).toEqual({ width: 992, height: 1024 });
    expect(detectionSize(5000, 100)).toEqual({ width: 4000, height: 64 });
    // A short side under 64 is scaled up to it.
    expect(detectionSize(120, 40)).toEqual({ width: 192, height: 64 });
});

test("the input is the BGR image normalized per channel as stored, planar", () => {
    const white = { width: 64, height: 64, channels: 3, data: new Uint8Array(64 * 64 * 3).fill(255) };
    const { tensor, width, height } = detectionInput(white);
    expect([width, height]).toEqual([64, 64]);
    const plane = 64 * 64;
    expect([tensor[0], tensor[plane], tensor[2 * plane]].map((value) => Math.round((value ?? 0) * 1e4) / 1e4)).toEqual([2.2489, 2.4286, 2.64]);
});

test("a blob of text-probability becomes one box, grown back out and scaled to the image (as DBPostProcess draws it)", () => {
    const width = 64;
    const height = 64;
    const map = new Float32Array(width * height);
    for (let y = 20; y <= 27; y += 1) {
        for (let x = 10; x <= 40; x += 1) {
            map[y * width + x] = 0.9;
        }
    }
    // paddlex's DBPostProcess, on the same map at thresh 0.3, box_thresh 0.6, unclip 1.5, for a 128 x 128 image:
    // [[12, 32], [88, 32], [88, 62], [12, 62]].
    expect(boxesFromMap(map, { width, height }, { width: 128, height: 128 })).toEqual([
        {
            corners: [
                { x: 12, y: 32 },
                { x: 88, y: 32 },
                { x: 88, y: 62 },
                { x: 12, y: 62 },
            ],
            score: expect.closeTo(0.9, 5),
        },
    ]);
});

test("a faint blob, or one too thin to be text, is no box", () => {
    const width = 64;
    const map = new Float32Array(width * width);
    for (let x = 10; x <= 40; x += 1) {
        // Above the pixel threshold, below the box threshold.
        map[20 * width + x] = 0.5;
        map[30 * width + x] = 0.95;
    }
    expect(boxesFromMap(map, { width, height: width }, { width, height: width })).toEqual([]);
});

test("boxes are read top to bottom, and left to right where their tops are within ten pixels", () => {
    const box = (x: number, y: number): { corners: Quad } => ({
        corners: [
            { x, y },
            { x: x + 10, y },
            { x: x + 10, y: y + 5 },
            { x, y: y + 5 },
        ],
    });
    const ordered = readingOrder([box(100, 12), box(10, 20), box(50, 40), box(5, 45)]);
    expect(ordered.map((entry) => [entry.corners[0].x, entry.corners[0].y])).toEqual([
        [10, 20],
        [100, 12],
        [5, 45],
        [50, 40],
    ]);
});
