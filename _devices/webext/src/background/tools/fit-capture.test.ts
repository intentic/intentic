import { fitSize, MODEL_IMAGE_LIMITS } from "@intentic/base/image-fit";
import { fitCapture } from "./fit-capture.js";

// A capture is shrunk to the size the desktop agent sends a screen at, and left as captured when it already fits. The
// drawing is the browser's (createImageBitmap, OffscreenCanvas), faked here with what the code asks of it.

const drawn: { size: [number, number]; at: [number, number, number, number] }[] = [];
let captureSize: [number, number] = [0, 0];

class FakeCanvas {
    constructor(
        readonly width: number,
        readonly height: number,
    ) {}
    getContext() {
        return {
            imageSmoothingQuality: "low",
            drawImage: (_bitmap: unknown, x: number, y: number, width: number, height: number) => {
                drawn.push({ size: [this.width, this.height], at: [x, y, width, height] });
            },
        };
    }
    async convertToBlob() {
        return new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
    }
}

beforeAll(() => {
    Object.assign(globalThis, {
        createImageBitmap: async () => ({ width: captureSize[0], height: captureSize[1], close: () => undefined }),
        OffscreenCanvas: FakeCanvas,
    });
});

const dataUrl = `data:image/png;base64,${btoa("captured")}`;

test("a 4K capture is drawn at the model's size, and that is what is sent", async () => {
    captureSize = [3840, 2160];
    expect(await fitCapture(dataUrl)).toBe(btoa(String.fromCharCode(1, 2, 3)));
    const { width, height } = fitSize(3840, 2160);
    expect(width * height).toBeLessThanOrEqual(MODEL_IMAGE_LIMITS.maxPixels);
    expect(drawn.at(-1)).toEqual({ size: [width, height], at: [0, 0, width, height] });
});

test("a capture that already fits is sent as captured, never redrawn", async () => {
    captureSize = [1280, 720];
    const before = drawn.length;
    expect(await fitCapture(dataUrl)).toBe(btoa("captured"));
    expect(drawn).toHaveLength(before);
});
