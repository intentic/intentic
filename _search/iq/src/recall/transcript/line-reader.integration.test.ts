import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { readCompressedLines, readLines, readTranscriptLines } from "./line-reader.js";

let dir: string;

beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "iq-recall-lines-"));
});
afterAll(() => rm(dir, { recursive: true, force: true }));

const collect = async (path: string, fromByte: number, read = readLines): Promise<{ json: string; endByte: number }[]> => {
    const lines: { json: string; endByte: number }[] = [];
    for await (const line of read(path, fromByte)) {
        lines.push(line);
    }
    return lines;
};

test("byte-exact offsets under multibyte UTF-8; partial tail never consumed", async () => {
    const path = join(dir, "multibyte.jsonl");
    await writeFile(path, "alpha\né中\u{1F600}\npartial-tail-no-newline");
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

// A transcript the sandbox compressed (`<id>.jsonl.zst`) reads as the same lines at the same offsets, from any of them.
test("a compressed transcript yields the plain file's lines and offsets, resumed part way too", async () => {
    const path = join(dir, "frozen.jsonl");
    const text = `alpha\n${"z".repeat(200_000)}\né中\npartial`;
    await writeFile(path, text);
    await writeFile(`${path}.zst`, zstdCompressSync(Buffer.from(text)));
    const plain = await collect(path, 0);
    expect(await collect(`${path}.zst`, 0, readCompressedLines)).toEqual(plain);
    expect(await collect(`${path}.zst`, plain[0]!.endByte, readCompressedLines)).toEqual(plain.slice(1));
    expect(await collect(`${path}.zst`, plain[1]!.endByte, readCompressedLines)).toEqual(plain.slice(2));
    // Only the plain file is read while both are there; only the compressed one once it alone is.
    expect(await collect(path, 0, readTranscriptLines)).toEqual(plain);
    await rm(path);
    expect(await collect(path, 0, readTranscriptLines)).toEqual(plain);
});

test("a compressed transcript that does not decompress fails its reader rather than reading as empty", async () => {
    const path = join(dir, "broken.jsonl.zst");
    await writeFile(path, "not zstd at all");
    await expect(collect(path, 0, readCompressedLines)).rejects.toThrow();
});
