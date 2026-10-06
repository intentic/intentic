import { serialLock } from "@intentic/base/async";
import { siblingModule, workerCalls } from "@intentic/base/worker-calls";
import { distance, lerp, type Quad } from "./geometry.js";
import { ocrInstalled, ocrModelDir } from "./models.js";
import type { Raster } from "./raster.js";

// Reading text off an image on this machine with PaddleOCR's PP-OCRv6 (PaddleOCR 3.7), the medium detector and
// recognizer as PaddlePaddle publishes them in ONNX, run by onnxruntime-node on a worker thread of this process
// (paddle-ocr-engine.ts): no Python, no PaddlePaddle, nothing sent anywhere. One recognizer covers 50 languages, Polish
// among them. The models come with the `privacy` image pack; without them the reader says so and nothing is read.

// One line of text as read: its words, how sure the model was, where it sits, and where on it each character is.
export interface OcrLine {
    readonly text: string;
    readonly score: number;
    // The line's box in the image's pixels, as the text reads: top-left, top-right, bottom-right, bottom-left. On a page
    // read upside down those are its text's own corners, so the first is at the picture's bottom right.
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

// Which way along the picture a line reads: 1 left to right, -1 right to left (a page read upside down).
const across = (line: Pick<OcrLine, "corners">): number => (line.corners[1].x < line.corners[0].x ? -1 : 1);

// Whether `next` continues `line`'s row: both horizontal, side by side the way they read, on the same level (their
// middles within half the smaller one's height). A form's label and its value, a table's cells.
const sameRow = (line: OcrLine, next: OcrLine): boolean =>
    !line.vertical &&
    !next.vertical &&
    across(line) * (next.corners[0].x - line.corners[1].x) >= -heightOf(line) &&
    Math.abs(middleY(line) - middleY(next)) < Math.min(heightOf(line), heightOf(next)) / 2;

// The lines as one text, in reading order: a tab between the pieces of one row (a label and its value read as one
// line, the cells of a table kept apart), a line break between rows. Each separator is one character, so a line's
// text starts where the lengths before it, plus one apiece, say.
export const pageText = (lines: readonly OcrLine[]): string =>
    lines.map((line, index) => (index === 0 ? "" : sameRow(lines[index - 1] as OcrLine, line) ? "\t" : "\n") + line.text).join("");

// What the reader's thread is asked (paddle-ocr-worker.ts), and what it is started with.
export type OcrAsk = { readonly kind: "load" } | { readonly kind: "read"; readonly image: Raster } | { readonly kind: "release" };
export interface OcrThread {
    readonly dir: string;
}

// Loads both models once, on a thread of their own; undefined when the pack is not installed or they will not load.
// onnxruntime-node runs a model synchronously on the thread that calls it, and the arithmetic around it is plain
// JavaScript: on the daemon's own thread one phone photo held every conversation, the editor and its sockets for 32 s.
// Here the caller pays for a copy of the pixels on the way in.
export const loadTextReader = async (
    dir: string = ocrModelDir(),
    warn: (message: string, error: unknown) => void = () => undefined,
): Promise<LoadedTextReader | undefined> => {
    if (!ocrInstalled(dir)) {
        return undefined;
    }
    const thread = workerCalls<OcrAsk>(siblingModule(import.meta, "paddle-ocr-worker"), { dir } satisfies OcrThread);
    try {
        await thread.call({ kind: "load" });
    } catch (error) {
        await thread.close();
        warn("privacy shield: the local text reader could not be loaded; images cannot be checked for personal data", error);
        return undefined;
    }
    // One image at a time: a request's walker hands every image over at once, and reading them in parallel would take
    // every core from the turns being shielded.
    const serially = serialLock();
    let released = false;
    return {
        read: (image) =>
            serially(async () => {
                if (released) {
                    throw new Error("the text reader was released");
                }
                return thread.call<OcrLine[]>({ kind: "read", image });
            }),
        release: () =>
            serially(async () => {
                if (released) {
                    return;
                }
                released = true;
                await thread.call({ kind: "release" });
                await thread.close();
            }),
    };
};
