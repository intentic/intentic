import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { readLines } from "./line-reader.js";

let dir: string;

beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "iq-recall-lines-"));
});
afterAll(() => rm(dir, { recursive: true, force: true }));

const collect = async (path: string, fromByte: number): Promise<{ json: string; endByte: number }[]> => {
    const lines: { json: string; endByte: number }[] = [];
    for await (const line of readLines(path, fromByte)) {
        lines.push(line);
    }
    return lines;
};

test("byte-exact offsets under multibyte UTF-8; partial tail never consumed", async () => {
    const path = join(dir, "multibyte.jsonl");
    await writeFile(path, 'alpha\né中\u{1F600}\npartial-tail-no-newline');
    const lines = await collect(path, 0);
    expect(lines.map((line) => line.json)).toEqual(["alpha", "é中\u{1F600}"]);
    expect(lines[0]!.endByte).toBe(Buffer.byteLength("alpha\n"));
    expect(lines[1]!.endByte).toBe(Buffer.byteLength("alpha\né中\u{1F600}\n"));
    const resumed = await collect(path, lines[0]!.endByte);
    expect(resumed.map((line) => line.json)).toEqual(["é中\u{1F600}"]);
    expect(resumed[0]!.endByte).toBe(lines[1]!.endByte);
});

test("a line spanning many stream chunks reassembles intact", async () => {
    const path = join(dir, "big.jsonl");
    const big = "x".repeat(300_000);
    await writeFile(path, `${big}\nafter\n`);
    const lines = await collect(path, 0);
    expect(lines[0]!.json).toBe(big);
    expect(lines[1]).toEqual({ json: "after", endByte: 300_001 + 6 });
});

test("oversized lines are consumed with exact offsets but yielded empty", async () => {
    const path = join(dir, "oversized.jsonl");
    const oversized = "y".repeat(11 * 1024 * 1024);
    await writeFile(path, `${oversized}\nafter\n`);
    const lines = await collect(path, 0);
    expect(lines[0]).toEqual({ json: "", endByte: oversized.length + 1 });
    expect(lines[1]).toEqual({ json: "after", endByte: oversized.length + 1 + 6 });
});
