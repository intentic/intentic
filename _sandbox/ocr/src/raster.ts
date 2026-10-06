import sharp from "sharp";
import { applyTransform, distance, perspectiveTransform, type Quad } from "./geometry.js";

// Pixels as the recognizer reads them, and the two resamplings it needs: a whole image scaled (bilinear, as OpenCV's
// INTER_LINEAR) and a tilted line of text laid flat (bicubic, as OpenCV's warpPerspective with INTER_CUBIC). Matching
// OpenCV here is what makes the ONNX models read as well as they do inside PaddleOCR, which feeds them through OpenCV.

// Interleaved 8-bit pixels; `channels` per pixel.
export interface Raster {
    readonly width: number;
    readonly height: number;
    readonly channels: number;
    readonly data: Uint8Array;
}

// The largest image read; a bigger one is refused rather than decoded into gigabytes.
const MAX_PIXELS = 64_000_000;

export interface DecodedImage {
    // Upright (EXIF orientation applied) RGBA.
    readonly rgba: Raster;
    // The container it came in, as sharp names it: png, jpeg, webp, gif…
    readonly format: string;
    // Whether it carried transparency; `rgba` always has an alpha channel.
    readonly hasAlpha: boolean;
    // How many frames it holds, of which `rgba` is the first: more than one is an animation (a GIF, a WebP), whose other
    // frames were not decoded.
    readonly frames: number;
}

// Undefined for bytes that are not an image sharp can read.
export const decodeImage = async (data: Buffer): Promise<DecodedImage | undefined> => {
    try {
        const image = sharp(data, { failOn: "none", limitInputPixels: MAX_PIXELS, animated: false });
        const { format, hasAlpha, pages } = await image.metadata();
        const { data: pixels, info } = await image.rotate().ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        return {
            rgba: { width: info.width, height: info.height, channels: info.channels, data: new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength) },
            format: format ?? "png",
            hasAlpha: hasAlpha === true,
            frames: Math.max(1, pages ?? 1),
        };
    } catch {
        // allow(silent-catch): bytes that will not decode are not an image this reader can read, which is its answer.
        return undefined;
    }
};

// RGBA to the BGR the models were trained on, transparent pixels laid over white: dark text on a transparent
// background would otherwise read as black on black.
export const toBgr = (rgba: Raster): Raster => {
    const { width, height, data } = rgba;
    const out = new Uint8Array(width * height * 3);
    for (let index = 0, at = 0; index < data.length; index += 4, at += 3) {
        const alpha = (data[index + 3] ?? 255) / 255;
        const over = (value: number): number => Math.round(value * alpha + 255 * (1 - alpha));
        out[at] = over(data[index + 2] ?? 0);
        out[at + 1] = over(data[index + 1] ?? 0);
        out[at + 2] = over(data[index] ?? 0);
    }
    return { width, height, channels: 3, data: out };
};

// One axis of OpenCV's INTER_LINEAR: for each destination index, the source index to its left and the weight of the
// one to its right, centres aligned, clamped at the edges.
const linearTaps = (from: number, to: number): { readonly left: Int32Array; readonly weight: Float32Array } => {
    const scale = from / to;
    const left = new Int32Array(to);
    const weight = new Float32Array(to);
    for (let index = 0; index < to; index += 1) {
        const at = (index + 0.5) * scale - 0.5;
        let base = Math.floor(at);
        let fraction = at - base;
        if (base < 0) {
            base = 0;
            fraction = 0;
        }
        if (base >= from - 1) {
            base = from - 1;
            fraction = 0;
        }
        left[index] = base;
        weight[index] = fraction;
    }
    return { left, weight };
};

// Scaled to `width` x `height`, bilinear, every channel; rounded back to 8 bits as OpenCV does.
export const resizeBilinear = (source: Raster, width: number, height: number): Raster => {
    const { channels, data } = source;
    const xs = linearTaps(source.width, width);
    const ys = linearTaps(source.height, height);
    const out = new Uint8Array(width * height * channels);
    const stride = source.width * channels;
    for (let y = 0; y < height; y += 1) {
        const y0 = ys.left[y] ?? 0;
        const y1 = Math.min(y0 + 1, source.height - 1);
        const fy = ys.weight[y] ?? 0;
        for (let x = 0; x < width; x += 1) {
            const x0 = xs.left[x] ?? 0;
            const x1 = Math.min(x0 + 1, source.width - 1);
            const fx = xs.weight[x] ?? 0;
            for (let c = 0; c < channels; c += 1) {
                const top = (data[y0 * stride + x0 * channels + c] ?? 0) * (1 - fx) + (data[y0 * stride + x1 * channels + c] ?? 0) * fx;
                const bottom = (data[y1 * stride + x0 * channels + c] ?? 0) * (1 - fx) + (data[y1 * stride + x1 * channels + c] ?? 0) * fx;
                out[(y * width + x) * channels + c] = Math.round(top * (1 - fy) + bottom * fy);
            }
        }
    }
    return { width, height, channels, data: out };
};

// OpenCV's bicubic kernel (A = -0.75), the four weights for a fractional offset.
const cubicWeights = (t: number): [number, number, number, number] => {
    const a = -0.75;
    const w0 = ((a * (t + 1) - 5 * a) * (t + 1) + 8 * a) * (t + 1) - 4 * a;
    const w1 = ((a + 2) * t - (a + 3)) * t * t + 1;
    const w2 = ((a + 2) * (1 - t) - (a + 3)) * (1 - t) * (1 - t) + 1;
    return [w0, w1, w2, 1 - w0 - w1 - w2];
};

const clampIndex = (value: number, size: number): number => (value < 0 ? 0 : value >= size ? size - 1 : value);

// `source` sampled bicubically at a fractional point, every channel, into `sums`; edges replicated.
const sampleBicubic = (source: Raster, at: { readonly x: number; readonly y: number }, sums: Float64Array): void => {
    const { channels, data } = source;
    const stride = source.width * channels;
    const bx = Math.floor(at.x);
    const by = Math.floor(at.y);
    const wx = cubicWeights(at.x - bx);
    const wy = cubicWeights(at.y - by);
    sums.fill(0);
    for (let j = 0; j < 4; j += 1) {
        const row = clampIndex(by - 1 + j, source.height) * stride;
        const fy = wy[j] ?? 0;
        for (let i = 0; i < 4; i += 1) {
            const column = clampIndex(bx - 1 + i, source.width) * channels;
            const weight = fy * (wx[i] ?? 0);
            for (let c = 0; c < channels; c += 1) {
                sums[c] = (sums[c] ?? 0) + (data[row + column + c] ?? 0) * weight;
            }
        }
    }
};

// The quadrilateral `corners` cut out of `source` and laid flat as a `width` x `height` image, edges replicated where
// the quadrilateral runs off the picture (OpenCV's BORDER_REPLICATE).
export const warpQuad = (source: Raster, corners: Quad, width: number, height: number): Raster => {
    const { channels } = source;
    const out = new Uint8Array(width * height * channels);
    const flat: Quad = [
        { x: 0, y: 0 },
        { x: width, y: 0 },
        { x: width, y: height },
        { x: 0, y: height },
    ];
    // Destination to source, so every output pixel asks where it comes from.
    const back = perspectiveTransform(flat, corners);
    const sums = new Float64Array(channels);
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            sampleBicubic(source, applyTransform(back, x, y), sums);
            for (let c = 0; c < channels; c += 1) {
                out[(y * width + x) * channels + c] = Math.min(255, Math.max(0, Math.round(sums[c] ?? 0)));
            }
        }
    }
    return { width, height, channels, data: out };
};

// Turned a quarter counter-clockwise (numpy's rot90), for a line of text that stands upright.
export const rotateCounterClockwise = (source: Raster): Raster => {
    const { width, height, channels, data } = source;
    const out = new Uint8Array(data.length);
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            const to = ((width - 1 - x) * height + y) * channels;
            const from = (y * width + x) * channels;
            for (let c = 0; c < channels; c += 1) {
                out[to + c] = data[from + c] ?? 0;
            }
        }
    }
    return { width: height, height: width, channels, data: out };
};

// Turned upside down: a picture taken or scanned the wrong way up, with no orientation tag to say so.
export const rotateHalfTurn = (source: Raster): Raster => {
    const { width, height, channels, data } = source;
    const out = new Uint8Array(data.length);
    const pixels = width * height;
    for (let index = 0; index < pixels; index += 1) {
        const from = index * channels;
        const to = (pixels - 1 - index) * channels;
        for (let c = 0; c < channels; c += 1) {
            out[to + c] = data[from + c] ?? 0;
        }
    }
    return { width, height, channels, data: out };
};

// The size PaddleOCR crops a box to: its longer pair of opposite sides, truncated.
export const cropSize = (corners: Quad): { readonly width: number; readonly height: number } => ({
    width: Math.trunc(Math.max(distance(corners[0], corners[1]), distance(corners[2], corners[3]))),
    height: Math.trunc(Math.max(distance(corners[0], corners[3]), distance(corners[1], corners[2]))),
});
