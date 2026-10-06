import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { InferenceSession, Tensor } from "onnxruntime-node";
import { serialLock } from "@intentic/base/async";
import { parse } from "yaml";
import { distance, lerp, minAreaRect, type Point, type Quad, rectCorners } from "./geometry.js";
import { DETECTOR, ocrInstalled, ocrModelDir, RECOGNIZER, RECOGNIZER_CONFIG } from "./models.js";
import { cropSize, type Raster, rotateCounterClockwise, toBgr, warpQuad } from "./raster.js";
import { boxesFromMap, detectionInput, readingOrder } from "./text-detection.js";
import { decodeCtc, RECOGNITION, recognitionBatch } from "./text-recognition.js";

// Reading text off an image on this machine with PaddleOCR's PP-OCRv6 (PaddleOCR 3.7), the medium detector and
// recognizer as PaddlePaddle publishes them in ONNX, run by onnxruntime-node in this process: no Python, no PaddlePaddle,
// nothing sent anywhere. One recognizer covers 50 languages, Polish among them. The models come with the `privacy`
// image pack; without them the reader says so and nothing is read.

// One line of text as read: its words, how sure the model was, where it sits, and where on it each character is.
export interface OcrLine {
    readonly text: string;
    readonly score: number;
    // The line's box in the image's pixels, reading order: top-left, top-right, bottom-right, bottom-left.
    readonly corners: Quad;
    // Each character of `text` in order (one recognizer symbol, which may be more than one UTF-16 unit) with the columns
    // of the line the model read it from, as fractions along the reading direction: 0 at the line's start, 1 at its
    // end. A glyph's ink reaches a little past the columns it was read from.
    readonly chars: readonly { readonly char: string; readonly from: number; readonly to: number }[];
    // One column of the recognizer's output, as a fraction of the line.
    readonly column: number;
    // Read top to bottom: the box stood upright and was turned to be read.
    readonly vertical: boolean;
}

export interface TextReader {
    // Every line of text in an upright RGBA image, in reading order.
    readonly read: (image: Raster) => Promise<OcrLine[]>;
}

// The reader loadTextReader makes. Its two model sessions hold over a gigabyte of native memory (1.5 GiB after reading
// one page, measured), which the garbage collector does not see, so a reader merely dropped can keep it for the rest of
// the process: the daemon keeps one for good, and anything done reading (a test among many in one process) releases it.
// Waits for a read in flight; nothing reads after.
export interface LoadedTextReader extends TextReader {
    readonly release: () => Promise<void>;
}

// The dictionary the recognizer's classes index, from its config.
const alphabetOf = async (dir: string): Promise<string[]> => {
    const config: unknown = parse(await readFile(join(dir, ...RECOGNIZER_CONFIG), "utf8"));
    const post = typeof config === "object" && config !== null ? (config as { PostProcess?: { character_dict?: unknown } }).PostProcess : undefined;
    const dict = post?.character_dict;
    if (!Array.isArray(dict) || dict.length === 0) {
        throw new Error("the recognizer's config names no character dictionary");
    }
    return dict.map(String);
};

const floats = (tensor: Tensor): Float32Array => {
    if (!(tensor.data instanceof Float32Array)) {
        throw new Error("the model answered something other than a float tensor");
    }
    return tensor.data;
};

// Where a stretch of a line, as fractions along its reading direction, sits on the image.
export const stretchOf = (line: Pick<OcrLine, "corners" | "vertical">, from: number, to: number): Quad => {
    const [topLeft, topRight, bottomRight, bottomLeft] = line.corners;
    if (line.vertical) {
        return [lerp(topLeft, bottomLeft, from), lerp(topRight, bottomRight, from), lerp(topRight, bottomRight, to), lerp(topLeft, bottomLeft, to)];
    }
    return [lerp(topLeft, topRight, from), lerp(topLeft, topRight, to), lerp(bottomLeft, bottomRight, to), lerp(bottomLeft, bottomRight, from)];
};

const middleY = (line: Pick<OcrLine, "corners">): number => line.corners.reduce((sum, point) => sum + point.y, 0) / 4;
const heightOf = (line: Pick<OcrLine, "corners">): number => distance(line.corners[0], line.corners[3]);

// Whether `next` continues `line`'s row: both horizontal, side by side, on the same level (their middles within half
// the smaller one's height). A form's label and its value, a table's cells.
const sameRow = (line: OcrLine, next: OcrLine): boolean =>
    !line.vertical &&
    !next.vertical &&
    next.corners[0].x >= line.corners[1].x - heightOf(line) &&
    Math.abs(middleY(line) - middleY(next)) < Math.min(heightOf(line), heightOf(next)) / 2;

// The lines as one text, in reading order: a tab between the pieces of one row (a label and its value read as one
// line, the cells of a table kept apart), a line break between rows. Each separator is one character, so a line's
// text starts where the lengths before it, plus one apiece, say.
export const pageText = (lines: readonly OcrLine[]): string =>
    lines.map((line, index) => (index === 0 ? "" : sameRow(lines[index - 1] as OcrLine, line) ? "\t" : "\n") + line.text).join("");

// Threads per model run: enough to read a screenshot in about a second, few enough to leave the turns it shields
// their cores.
const THREADS = 4;

// Loads both models once; undefined when the pack is not installed or they will not load.
export const loadTextReader = async (
    dir: string = ocrModelDir(),
    warn: (message: string, error: unknown) => void = () => undefined,
): Promise<LoadedTextReader | undefined> => {
    if (!ocrInstalled(dir)) {
        return undefined;
    }
    try {
        // Loaded on first use: a sandbox that never reads an image never maps the runtime's native library.
        const ort = await import("onnxruntime-node");
        const options: InferenceSession.SessionOptions = { intraOpNumThreads: THREADS, interOpNumThreads: 1, graphOptimizationLevel: "all" };
        const [detector, recognizer, alphabet] = await Promise.all([
            ort.InferenceSession.create(join(dir, ...DETECTOR), options),
            ort.InferenceSession.create(join(dir, ...RECOGNIZER), options),
            alphabetOf(dir),
        ]);
        const run = async (session: InferenceSession, tensor: Float32Array, dims: readonly number[]): Promise<Tensor> => {
            const output = await session.run({ [session.inputNames[0] ?? "x"]: new ort.Tensor("float32", tensor, dims) });
            const answer = output[session.outputNames[0] ?? ""];
            if (answer === undefined) {
                throw new Error("the model gave no output");
            }
            return answer;
        };

        // Each box laid flat for the recognizer, through its own smallest rectangle as PaddleOCR's
        // get_minarea_rect_crop does; an upright one is turned to be read.
        const crop = (bgr: Raster, corners: Quad): { box: Quad; line: Raster; vertical: boolean } | undefined => {
            const box = rectCorners(minAreaRect(corners.map((point: Point) => ({ x: Math.trunc(point.x), y: Math.trunc(point.y) }))));
            const size = cropSize(box);
            if (size.width <= 0 || size.height <= 0) {
                return undefined;
            }
            const flat = warpQuad(bgr, box, size.width, size.height);
            const vertical = size.height / size.width >= 1.5;
            return { box, line: vertical ? rotateCounterClockwise(flat) : flat, vertical };
        };

        // One line per run. PaddleOCR batches lines of similar shape, padding each batch to its widest; read alone, a
        // line reads the same whatever else the image holds, and measured here batching bought no speed.
        const recognize = async (cropped: { box: Quad; line: Raster; vertical: boolean }): Promise<OcrLine | undefined> => {
            const batch = recognitionBatch([cropped.line]);
            const output = await run(recognizer, batch.tensor, [1, 3, RECOGNITION.height, batch.width]);
            const read = decodeCtc(floats(output), output.dims[1] ?? 0, alphabet, (batch.contentWidths[0] ?? 0) / batch.width);
            if (read.text.trim() === "") {
                return undefined;
            }
            // Each character's columns as fractions of the line: where the model saw it, not yet how far its ink reaches.
            const span = read.contentColumns;
            const chars = read.chars.map((char) => ({
                char: char.char,
                from: Math.max(0, Math.min(1, char.from / span)),
                to: Math.max(0, Math.min(1, (char.to + 1) / span)),
            }));
            return { text: read.text, score: read.score, corners: cropped.box, chars, column: span > 0 ? 1 / span : 1, vertical: cropped.vertical };
        };

        // One image at a time: a request's walker hands every image over at once, and reading them in parallel would
        // take every core from the turns being shielded.
        const serially = serialLock();

        return {
            read: (image) =>
                serially(async () => {
                    const bgr = toBgr(image);
                    const input = detectionInput(bgr);
                    const map = await run(detector, input.tensor, [1, 3, input.height, input.width]);
                    const boxes = readingOrder(
                        boxesFromMap(floats(map), { width: map.dims[3] ?? input.width, height: map.dims[2] ?? input.height }, bgr),
                    );
                    const lines: OcrLine[] = [];
                    for (const box of boxes) {
                        const cropped = crop(bgr, box.corners);
                        const line = cropped === undefined ? undefined : await recognize(cropped);
                        if (line !== undefined) {
                            lines.push(line);
                        }
                    }
                    return lines;
                }),
            release: () =>
                serially(async () => {
                    await Promise.all([detector.release(), recognizer.release()]);
                }),
        };
    } catch (error) {
        warn("privacy shield: the local text reader could not be loaded; images cannot be checked for personal data", error);
        return undefined;
    }
};
