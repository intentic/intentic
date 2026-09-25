import { execFile } from "node:child_process";
import { appendFile, mkdtemp, readFile, rm, stat, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { zstdDecompressSync } from "node:zlib";
import { appendLog, frameBytes, frameOfRow, jsonlOf, openLog, readFrame, repairLog, writeLog } from "./record-log.js";
import * as recordIo from "./record-io.js";

// The record's file format against a real file: frames found without decompressing the ones before, a torn last frame
// read past by any reader and cut away by the writer, and the whole log readable by the standard zstd tools as JSONL.

const exec = promisify(execFile);
const readZstd = async (path: string): Promise<string> => {
    try {
        return (await exec("zstdcat", [path])).stdout;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return zstdDecompressSync(await readFile(path)).toString("utf8");
        }
        throw error;
    }
};

let dir: string;
beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "intentic-record-log-"));
});
afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

const lines = (from: number, count: number): string[] => Array.from({ length: count }, (_, at) => JSON.stringify({ role: "user", text: `row ${String(from + at)}` }));

test("finds every row's frame and reads it back, however many frames came before", async () => {
    const path = join(dir, "transcript.jsonl.zst");
    let index = await openLog(path);
    expect(index).toBeUndefined();
    for (let turn = 0; turn < 5; turn++) {
        index = await appendLog(path, index, lines(turn * 3, 3));
    }
    const reopened = await openLog(path);
    expect(reopened?.rows).toBe(15);
    expect(reopened?.frames).toEqual(index?.frames);
    const { frame, line } = frameOfRow(reopened!, 10);
    expect(JSON.parse((await readFrame(path, reopened!.frames[frame]!))[line]!)).toEqual({ role: "user", text: "row 10" });
});

test("opening reads past a torn last frame without touching it, and a repair cuts it so the next frame lands whole", async () => {
    const path = join(dir, "transcript.jsonl.zst");
    let index = await appendLog(path, undefined, lines(0, 2));
    index = await appendLog(path, index, lines(2, 2));
    const whole = (await stat(path)).size;
    // A crash midway through the second frame's write.
    await truncate(path, whole - 7);
    const opened = await openLog(path);
    expect(opened?.rows).toBe(2);
    expect((await stat(path)).size).toBe(whole - 7);
    const repaired = await repairLog(path, opened!);
    expect((await stat(path)).size).toBe(repaired.end);
    const next = await appendLog(path, repaired, lines(9, 1));
    expect((await openLog(path))?.rows).toBe(3);
    expect(next.rows).toBe(3);
});

test("a reader opening the log while a frame is still landing leaves that frame be", async () => {
    const path = join(dir, "transcript.jsonl.zst");
    await appendLog(path, undefined, lines(0, 1));
    const landing = frameBytes(jsonlOf(lines(1, 2)), 2);
    // The first pages of one write, as another process sees them before the rest arrive.
    await appendFile(path, landing.subarray(0, 30));
    expect((await openLog(path))?.rows).toBe(1);
    await appendFile(path, landing.subarray(30));
    expect((await openLog(path))?.rows).toBe(3);
});

test("cuts away a last frame whose bytes are all there but wrong", async () => {
    const path = join(dir, "transcript.jsonl.zst");
    const index = await appendLog(path, await appendLog(path, undefined, lines(0, 1)), lines(1, 1));
    const bytes = await readFile(path);
    const last = index.frames.at(-1)!;
    const at = last.offset + Math.floor(last.length / 2);
    bytes.writeUInt8((bytes.readUInt8(at) ^ 0xff) & 0xff, at);
    await writeFile(path, bytes);
    expect((await openLog(path))?.rows).toBe(1);
});

test("zstdcat reads a log as the JSONL it holds, rewritten or appended", async () => {
    const path = join(dir, "transcript.jsonl.zst");
    await writeLog(path, [lines(0, 2), [], lines(2, 1)]);
    await appendLog(path, await openLog(path), lines(3, 1));
    const stdout = await readZstd(path);
    expect(stdout).toBe(`${lines(0, 4).join("\n")}\n`);
});

test("stray bytes after the last frame are not a frame", async () => {
    const path = join(dir, "transcript.jsonl.zst");
    await appendLog(path, undefined, lines(0, 2));
    await appendFile(path, Buffer.from("not a frame"));
    expect((await openLog(path))?.rows).toBe(2);
});

test("does not acknowledge a new or replaced log when persisting its directory fails", async () => {
    const path = join(dir, "transcript.jsonl.zst");
    const failure = new Error("directory sync failed");
    const sync = jest.spyOn(recordIo, "syncParents").mockRejectedValue(failure);
    try {
        await expect(appendLog(path, undefined, lines(0, 1))).rejects.toThrow("directory sync failed");
        await expect(writeLog(path, [lines(1, 1)])).rejects.toThrow("directory sync failed");
        expect(sync.mock.calls).toEqual([[path], [path]]);
    } finally {
        sync.mockRestore();
    }
});
