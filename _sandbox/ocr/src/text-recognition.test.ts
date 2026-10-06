import { decodeCtc, RECOGNITION, recognitionBatch } from "./text-recognition.js";

// PP-OCRv6's recognizer around the model: how a line is fed to it, and how its columns are read back the CTC way,
// each character keeping the columns it came from.

test("a line is fed at the model's height and its own aspect, never narrower than the minimum, padded on the right", () => {
    const short = { width: 40, height: 20, channels: 3, data: new Uint8Array(40 * 20 * 3).fill(255) };
    const long = { width: 800, height: 20, channels: 3, data: new Uint8Array(800 * 20 * 3).fill(0) };
    const one = recognitionBatch([short]);
    expect([one.width, one.contentWidths]).toEqual([RECOGNITION.minWidth, [96]]);
    // White is 1 after normalization; the padding to its right is 0.
    expect([one.tensor[0], one.tensor[95], one.tensor[96]]).toEqual([1, 1, 0]);
    const two = recognitionBatch([short, long]);
    expect([two.width, two.contentWidths]).toEqual([1920, [96, 1920]]);
    expect(two.tensor.length).toBe(2 * 3 * RECOGNITION.height * 1920);
});

test("CTC: repeats merge, blanks split, the last class is a space, and each character keeps its columns", () => {
    const alphabet = ["a", "b"];
    // Classes: blank, a, b, space.
    const best = [1, 1, 0, 1, 2, 3, 2, 0];
    const probabilities = new Float32Array(best.length * 4);
    best.forEach((klass, column) => {
        probabilities[column * 4 + klass] = column === 0 ? 0.6 : 0.9;
    });
    const read = decodeCtc(probabilities, best.length, alphabet, 0.5);
    expect(read.text).toBe("aab b");
    expect(read.chars).toEqual([
        { char: "a", from: 0, to: 1 },
        { char: "a", from: 3, to: 3 },
        { char: "b", from: 4, to: 4 },
        { char: " ", from: 5, to: 5 },
        { char: "b", from: 6, to: 6 },
    ]);
    // The mean of each kept character's first column, as PaddleOCR scores a line.
    expect(read.score).toBeCloseTo((0.6 + 0.9 * 4) / 5, 6);
    expect([read.columns, read.contentColumns]).toEqual([8, 4]);
});

test("a line of nothing but blanks reads as empty, scored zero", () => {
    const probabilities = new Float32Array(3 * 4);
    probabilities[0] = 1;
    probabilities[4] = 1;
    probabilities[8] = 1;
    expect(decodeCtc(probabilities, 3, ["a", "b"], 1)).toMatchObject({ text: "", score: 0, chars: [] });
});
