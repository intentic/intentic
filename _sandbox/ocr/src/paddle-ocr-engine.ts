import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { InferenceSession, Tensor } from "onnxruntime-node";
import { parse } from "yaml";
import { minAreaRect, type Point, type Quad, rectCorners } from "./geometry.js";
import { DETECTOR, RECOGNIZER, RECOGNIZER_CONFIG } from "./models.js";
import type { OcrLine } from "./paddle-ocr.js";
import { cropSize, type Raster, rotateCounterClockwise, rotateHalfTurn, toBgr, warpQuad } from "./raster.js";
import { boxesFromMap, detectionInput, readingOrder } from "./text-detection.js";
import { decodeCtc, RECOGNITION, recognitionBatch } from "./text-recognition.js";

// The two models and everything around them, run on the thread that loads them: onnxruntime-node runs a model
// synchronously on the thread that calls it, and the pre- and post-processing is plain JavaScript, so reading one photo
// holds that thread for tens of seconds. paddle-ocr-worker.ts is that thread; nothing else loads this module.

export interface OcrEngine {
    readonly read: (image: Raster) => Promise<OcrLine[]>;
    readonly release: () => Promise<void>;
}

// The dictionary the recognizer's classes index, from its config.
const alphabetOf = async (dir: string): Promise<string[]> => {
    // SAFETY: read only through optional chaining, whatever the YAML held, and what it names is checked to be a
    // non-empty array before it is used.
    const config = parse(await readFile(join(dir, ...RECOGNIZER_CONFIG), "utf8")) as { readonly PostProcess?: { readonly character_dict?: unknown } } | null;
    const dict = config?.PostProcess?.character_dict;
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

// How much a reading holds: its characters, and the same counted by how sure the model was of each one's line.
const charsOf = (lines: readonly OcrLine[]) => {
    let all = 0;
    let sure = 0;
    for (const line of lines) {
        const count = line.text.replaceAll(/\s/gu, "").length;
        all += count;
        sure += line.score * count;
    }
    return { all, sure };
};

// A reading with fewer sure characters than this, or less sure of them on the whole, is tried again upside down, and
// the way up that reads more is kept (keptReading). Text upside down reads as a few unsure characters of nothing: a page with three
// lines on its head read as 15 characters at 0.58 to 0.81 (11 sure ones), the right way up as 63 at 0.99 and over.
const RETRY_BELOW = 24;
const SURE_SHARE = 0.9;
const mostlySure = (chars: { readonly all: number; readonly sure: number }): boolean => chars.sure >= SURE_SHARE * chars.all;
const settled = (lines: readonly OcrLine[]): boolean => {
    const chars = charsOf(lines);
    return chars.sure >= RETRY_BELOW && mostlySure(chars);
};

/**
 * Which way up to keep once the upright reading has not settled: the reading upside down only where it reads more sure
 * characters and is itself mostly sure. A reading that is mostly unsure is what text on its head looks like, so it never
 * displaces an upright one, however many characters it strings together: a phone photo whose line the detector half
 * found read "Faktura" upright and 28 characters of nothing (81% sure) turned over, and the nothing was kept.
 */
export const keptReading = (upright: readonly OcrLine[], turned: readonly OcrLine[]): readonly OcrLine[] => {
    const turnedChars = charsOf(turned);
    return turnedChars.sure > charsOf(upright).sure && mostlySure(turnedChars) ? turned : upright;
};

// A line read off the picture turned upside down, placed back on the picture as it is: every corner turned a half turn
// about the centre, so its reading direction runs right to left, as the text on the picture does.
const turnedBack = (line: OcrLine, width: number, height: number): OcrLine => {
    const turn = (point: Point): Point => ({ x: width - point.x, y: height - point.y });
    const [topLeft, topRight, bottomRight, bottomLeft] = line.corners;
    return { ...line, corners: [turn(topLeft), turn(topRight), turn(bottomRight), turn(bottomLeft)] };
};

// Threads per model run: enough to read a screenshot in about a second, few enough to leave the turns it shields
// their cores.
const THREADS = 4;

// Loads both models; throws when they will not load.
export const loadOcrEngine = async (dir: string): Promise<OcrEngine> => {
    // Loaded on first use: a sandbox that never reads an image never maps the runtime's native library.
    const ort = await import("onnxruntime-node");
    // No arena and no memory pattern: with them each session keeps buffers sized to the largest image it has read, and
    // reading a 4000 x 3000 photo took the process to 5.7 GiB; without them it peaked at 2.6 GiB, and no slower
    // (measured 2026-10-06 over paddle-ocr.integration.test.ts).
    const options: InferenceSession.SessionOptions = {
        intraOpNumThreads: THREADS,
        interOpNumThreads: 1,
        graphOptimizationLevel: "all",
        enableCpuMemArena: false,
        enableMemPattern: false,
    };
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

    // Each box laid flat for the recognizer, through its own smallest rectangle as PaddleOCR's get_minarea_rect_crop
    // does; an upright one is turned to be read.
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

    // One line per run. PaddleOCR batches lines of similar shape, padding each batch to its widest; read alone, a line
    // reads the same whatever else the image holds, and measured here batching bought no speed.
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

    // Every line of an upright image, in reading order.
    const readUpright = async (image: Raster): Promise<OcrLine[]> => {
        const bgr = toBgr(image);
        const input = detectionInput(bgr);
        const map = await run(detector, input.tensor, [1, 3, input.height, input.width]);
        const boxes = readingOrder(boxesFromMap(floats(map), { width: map.dims[3] ?? input.width, height: map.dims[2] ?? input.height }, bgr));
        const lines: OcrLine[] = [];
        for (const box of boxes) {
            const cropped = crop(bgr, box.corners);
            const line = cropped === undefined ? undefined : await recognize(cropped);
            if (line !== undefined) {
                lines.push(line);
            }
        }
        return lines;
    };

    return {
        read: async (image) => {
            const upright = await readUpright(image);
            if (settled(upright)) {
                return upright;
            }
            const turned = (await readUpright(rotateHalfTurn(image))).map((line) => turnedBack(line, image.width, image.height));
            return [...keptReading(upright, turned)];
        },
        release: async () => {
            await Promise.all([detector.release(), recognizer.release()]);
        },
    };
};
