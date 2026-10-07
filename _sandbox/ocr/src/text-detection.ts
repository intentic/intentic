import { fillPolygon, grownRect, minAreaRect, type Point, type Quad, rectCorners, roundHalfEven } from "./geometry.js";
import { type Raster, resizeBilinear } from "./raster.js";

// PP-OCRv6's text detector around its ONNX model: the image scaled as PaddleOCR scales it, normalized as it was
// trained, and the probability map the model answers turned into one box per line of text by Differentiable
// Binarization's post-processing (threshold, blobs, smallest rotated rectangle, score, grow). The parameters are the
// OCR pipeline's own defaults in PaddleOCR 3.7 (paddlex/configs/pipelines/OCR.yaml), except `boxThreshold`.

export const DETECTION = {
    // An image whose shorter side is below this is scaled up to it; nothing is scaled down below the longest side.
    limitSideLength: 64,
    maxSideLength: 4000,
    // A pixel is text where the model's probability passes this.
    threshold: 0.3,
    // A blob is a line where its mean probability passes this. PaddleOCR's 0.6 dropped the most of a line a phone photo
    // held: on a mottled background at 4000 x 3000 the blob for "4815162342 z dnia 12.03.2026" scored 0.583, and only
    // "Faktura" was read (measured 2026-10-07, in DejaVu Sans). The shield is here to find text, so a missed line costs
    // more than a box of noise, which reads as nothing that looks like personal data.
    boxThreshold: 0.5,
    // How far a found box is grown back out, the model having been trained on shrunk ones.
    unclipRatio: 1.5,
    minSize: 3,
    maxCandidates: 3000,
} as const;

const MEAN = [0.485, 0.456, 0.406] as const;
const STD = [0.229, 0.224, 0.225] as const;

export interface DetectionInput {
    // NCHW float32, one image.
    readonly tensor: Float32Array;
    readonly width: number;
    readonly height: number;
}

// The size the detector reads an image at: never smaller than the limit on its short side, never larger than the
// maximum on its long side, each side a multiple of 32.
export const detectionSize = (width: number, height: number): { readonly width: number; readonly height: number } => {
    let ratio = 1;
    if (Math.min(width, height) < DETECTION.limitSideLength) {
        ratio = DETECTION.limitSideLength / Math.min(width, height);
    }
    let resizedWidth = Math.trunc(width * ratio);
    let resizedHeight = Math.trunc(height * ratio);
    if (Math.max(resizedWidth, resizedHeight) > DETECTION.maxSideLength) {
        const shrink = DETECTION.maxSideLength / Math.max(resizedWidth, resizedHeight);
        resizedWidth = Math.trunc(resizedWidth * shrink);
        resizedHeight = Math.trunc(resizedHeight * shrink);
    }
    return {
        width: Math.max(roundHalfEven(resizedWidth / 32) * 32, 32),
        height: Math.max(roundHalfEven(resizedHeight / 32) * 32, 32),
    };
};

// The BGR image as the detector's input tensor. The mean and deviation are applied in channel order as stored, which is
// how PaddleOCR applies them to its BGR images, and so how the model learned them.
export const detectionInput = (bgr: Raster): DetectionInput => {
    const size = detectionSize(bgr.width, bgr.height);
    const scaled = size.width === bgr.width && size.height === bgr.height ? bgr : resizeBilinear(bgr, size.width, size.height);
    const plane = size.width * size.height;
    const tensor = new Float32Array(plane * 3);
    for (let index = 0; index < plane; index += 1) {
        for (let c = 0; c < 3; c += 1) {
            tensor[c * plane + index] = ((scaled.data[index * 3 + c] ?? 0) / 255 - (MEAN[c] ?? 0)) / (STD[c] ?? 1);
        }
    }
    return { tensor, width: size.width, height: size.height };
};

interface Grid {
    readonly bitmap: Uint8Array;
    // Which blob each pixel was claimed by, 0 for none yet.
    readonly label: Int32Array;
    readonly width: number;
    readonly height: number;
}

// The unclaimed ink among the eight pixels around `at`, claimed for blob `id` and queued to spread from.
const claimNeighbours = (grid: Grid, at: number, id: number, queue: number[]): void => {
    const { bitmap, label, width, height } = grid;
    const x = at % width;
    const y = (at - x) / width;
    for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
            const nx = x + dx;
            const ny = y + dy;
            const next = ny * width + nx;
            const inside = (dx !== 0 || dy !== 0) && nx >= 0 && nx < width && ny >= 0 && ny < height;
            if (inside && bitmap[next] !== 0 && label[next] === 0) {
                label[next] = id;
                queue.push(next);
            }
        }
    }
};

// A row's leftmost and rightmost pixel so far, widened to take in (x, y).
const widen = (extremes: Map<number, { min: number; max: number }>, x: number, y: number): void => {
    const row = extremes.get(y);
    if (row === undefined) {
        extremes.set(y, { min: x, max: x });
        return;
    }
    row.min = Math.min(row.min, x);
    row.max = Math.max(row.max, x);
};

// 8-connected blobs of the thresholded map, each as its rows' leftmost and rightmost pixels: all the convex hull needs.
const blobs = (bitmap: Uint8Array, width: number, height: number): Point[][] => {
    const grid: Grid = { bitmap, label: new Int32Array(width * height), width, height };
    const found: Point[][] = [];
    const queue: number[] = [];
    for (let start = 0; start < bitmap.length; start += 1) {
        if (bitmap[start] === 0 || grid.label[start] !== 0) {
            continue;
        }
        const id = found.length + 1;
        grid.label[start] = id;
        queue.push(start);
        const extremes = new Map<number, { min: number; max: number }>();
        while (queue.length > 0) {
            const at = queue.pop() ?? 0;
            const x = at % width;
            widen(extremes, x, (at - x) / width);
            claimNeighbours(grid, at, id, queue);
        }
        found.push([...extremes].flatMap(([y, { min, max }]) => (min === max ? [{ x: min, y }] : [{ x: min, y }, { x: max, y }])));
    }
    return found;
};

// The mean probability inside a box, over the pixels its integer outline covers (PaddleOCR's box_score_fast).
const boxScore = (probabilities: Float32Array, width: number, height: number, corners: Quad): number => {
    let sum = 0;
    let count = 0;
    const outline = corners.map((point) => ({ x: Math.trunc(point.x), y: Math.trunc(point.y) }));
    fillPolygon(outline, { width, height }, (y, fromX, toX) => {
        for (let x = fromX; x <= toX; x += 1) {
            sum += probabilities[y * width + x] ?? 0;
            count += 1;
        }
    });
    return count === 0 ? 0 : sum / count;
};

export interface DetectedBox {
    readonly corners: Quad;
    readonly score: number;
}

// The model's probability map (at the detection size) to boxes in the original image's pixels.
export const boxesFromMap = (
    probabilities: Float32Array,
    map: { readonly width: number; readonly height: number },
    original: { readonly width: number; readonly height: number },
): DetectedBox[] => {
    const { width, height } = map;
    const bitmap = new Uint8Array(width * height);
    for (let index = 0; index < bitmap.length; index += 1) {
        bitmap[index] = (probabilities[index] ?? 0) > DETECTION.threshold ? 1 : 0;
    }
    const scaleX = original.width / width;
    const scaleY = original.height / height;
    const boxes: DetectedBox[] = [];
    for (const points of blobs(bitmap, width, height).slice(0, DETECTION.maxCandidates)) {
        const rect = minAreaRect(points);
        if (Math.min(rect.width, rect.height) < DETECTION.minSize) {
            continue;
        }
        const score = boxScore(probabilities, width, height, rectCorners(rect));
        if (score < DETECTION.boxThreshold) {
            continue;
        }
        // Offsetting the box's outline by area * ratio / perimeter, as pyclipper does for PaddleOCR, grows a rectangle
        // by that much on every side; pyclipper works in integers, truncating the outline it is given and rounding the
        // one it returns, and the smallest rectangle of that is the box.
        const grow = (rect.width * rect.height * DETECTION.unclipRatio) / (2 * (rect.width + rect.height));
        const truncated = minAreaRect(rectCorners(rect).map((point) => ({ x: Math.trunc(point.x), y: Math.trunc(point.y) })));
        const grown = minAreaRect(rectCorners(grownRect(truncated, grow)).map((point) => ({ x: Math.round(point.x), y: Math.round(point.y) })));
        if (Math.min(grown.width, grown.height) < DETECTION.minSize + 2) {
            continue;
        }
        const corners = rectCorners(grown).map((point) => ({
            x: Math.max(0, Math.min(roundHalfEven(point.x * scaleX), original.width)),
            y: Math.max(0, Math.min(roundHalfEven(point.y * scaleY), original.height)),
        }));
        boxes.push({ corners: corners as unknown as Quad, score });
    }
    return boxes;
};

// Top to bottom, then left to right among boxes whose tops are within ten pixels (PaddleOCR's sorted_boxes).
export const readingOrder = <T extends { readonly corners: Quad }>(boxes: readonly T[]): T[] => {
    const sorted = boxes.toSorted((a, b) => a.corners[0].y - b.corners[0].y || a.corners[0].x - b.corners[0].x);
    for (let index = 0; index < sorted.length - 1; index += 1) {
        for (let j = index; j >= 0; j -= 1) {
            const current = sorted[j] as T;
            const next = sorted[j + 1] as T;
            if (Math.abs(next.corners[0].y - current.corners[0].y) < 10 && next.corners[0].x < current.corners[0].x) {
                sorted[j] = next;
                sorted[j + 1] = current;
            } else {
                break;
            }
        }
    }
    return sorted;
};
