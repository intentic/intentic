import { type Raster, resizeBilinear } from "./raster.js";

// PP-OCRv6's text recognizer around its ONNX model: one flattened line of text scaled to the model's height, read as
// a sequence of character columns, and decoded the CTC way (repeats merged, blanks dropped). Each character keeps the
// columns it was read from, which is how a span of the text is found again on the picture.

export const RECOGNITION = {
    height: 48,
    // The narrowest input, and the widest PaddleOCR feeds the model.
    minWidth: 320,
    maxWidth: 3200,
} as const;

export interface RecognitionBatch {
    // NCHW float32: the lines, BGR, each scaled to the model's height and padded with zeros on the right to `width`.
    readonly tensor: Float32Array;
    readonly count: number;
    readonly width: number;
    // How much of `width` each line itself fills; the rest is padding.
    readonly contentWidths: readonly number[];
}

// How wide one line is fed: as wide as its aspect asks (never under the minimum), and how much of that it fills.
const lineWidth = (line: Raster): { readonly input: number; readonly content: number } => {
    const { height, minWidth, maxWidth } = RECOGNITION;
    const ratio = line.width / line.height;
    const input = Math.trunc(height * Math.max(minWidth / height, ratio));
    if (input > maxWidth) {
        return { input: maxWidth, content: maxWidth };
    }
    return { input, content: Math.min(input, Math.ceil(height * ratio)) };
};

// PaddleOCR's resize_norm_img over a batch: each line scaled to the model's height at its own aspect, filling its row
// from the left, the batch as wide as its widest line.
export const recognitionBatch = (lines: readonly Raster[]): RecognitionBatch => {
    const { height } = RECOGNITION;
    const widths = lines.map(lineWidth);
    const width = Math.max(...widths.map((entry) => entry.input));
    const plane = height * width;
    const tensor = new Float32Array(plane * 3 * lines.length);
    const contentWidths: number[] = [];
    lines.forEach((line, index) => {
        const scaled = resizeBilinear(line, Math.max(1, widths[index]?.content ?? 1), height);
        contentWidths.push(scaled.width);
        const base = index * plane * 3;
        for (let y = 0; y < height; y += 1) {
            for (let x = 0; x < scaled.width; x += 1) {
                for (let c = 0; c < 3; c += 1) {
                    tensor[base + c * plane + y * width + x] = ((scaled.data[(y * scaled.width + x) * 3 + c] ?? 0) / 255 - 0.5) / 0.5;
                }
            }
        }
    });
    return { tensor, count: lines.length, width, contentWidths };
};

export interface RecognizedChar {
    readonly char: string;
    // The first and last column (inclusive) of the model's output this character was read from.
    readonly from: number;
    readonly to: number;
}

export interface Recognition {
    readonly text: string;
    // The mean of the kept characters' probabilities, as PaddleOCR scores a line.
    readonly score: number;
    readonly chars: readonly RecognizedChar[];
    // Columns the output has, and how many of them cover the line rather than padding.
    readonly columns: number;
    readonly contentColumns: number;
}

// `probabilities` is one line's [columns, classes], row-major; class 0 is CTC's blank, the dictionary follows, and the
// last class is the space PaddleOCR appends to it. `fill` is how much of the input's width the line filled.
export const decodeCtc = (probabilities: Float32Array, columns: number, alphabet: readonly string[], fill: number): Recognition => {
    const classes = alphabet.length + 2;
    const chars: { char: string; from: number; to: number }[] = [];
    const scores: number[] = [];
    let previous = -1;
    for (let column = 0; column < columns; column += 1) {
        let best = 0;
        let bestScore = Number.NEGATIVE_INFINITY;
        const offset = column * classes;
        for (let k = 0; k < classes; k += 1) {
            const value = probabilities[offset + k] ?? 0;
            if (value > bestScore) {
                bestScore = value;
                best = k;
            }
        }
        if (best !== 0 && best === previous) {
            // The same character held across columns: it runs on.
            const last = chars.at(-1);
            if (last !== undefined) {
                last.to = column;
            }
        } else if (best !== 0) {
            chars.push({ char: best === classes - 1 ? " " : (alphabet[best - 1] ?? ""), from: column, to: column });
            scores.push(bestScore);
        }
        previous = best;
    }
    return {
        text: chars.map((entry) => entry.char).join(""),
        score: scores.length === 0 ? 0 : scores.reduce((sum, value) => sum + value, 0) / scores.length,
        chars,
        columns,
        contentColumns: columns * fill,
    };
};
