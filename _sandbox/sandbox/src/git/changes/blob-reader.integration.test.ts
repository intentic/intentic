import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { readObject } from "./blob-reader.js";

// The resident reader against a real repository: the bytes git has, nothing for a missing or oversized object, and an
// index spec read afresh, since a long-lived reader would answer it from the index it started with.

const exec = promisify(execFile);
const sh = async (cwd: string, ...args: string[]): Promise<string> => (await exec("git", ["-C", cwd, ...args])).stdout.trim();

let dir: string;
beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "intentic-blob-reader-"));
    await sh(dir, "init", "-q");
    await writeFile(join(dir, "a.txt"), "first\n");
    await writeFile(join(dir, "big.bin"), Buffer.alloc(4096, 7));
    await sh(dir, "add", "-A");
    await sh(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "one");
});
afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
});

test("reads blobs and committed paths by name, many at once, byte for byte", async () => {
    const commit = await sh(dir, "rev-parse", "HEAD");
    const blob = await sh(dir, "rev-parse", "HEAD:a.txt");
    const reads = await Promise.all(Array.from({ length: 20 }, (_, index) => readObject(dir, index % 2 === 0 ? blob : `${commit}:a.txt`, 1024)));
    expect(reads.every((bytes) => bytes?.toString("utf8") === "first\n")).toBe(true);
    expect((await readObject(dir, `${commit}:big.bin`, 8192))?.equals(Buffer.alloc(4096, 7))).toBe(true);
});

test("answers nothing for a missing object or one past the cap", async () => {
    const commit = await sh(dir, "rev-parse", "HEAD");
    expect(await readObject(dir, `${commit}:nope.txt`, 1024)).toBeUndefined();
    expect(await readObject(dir, "0".repeat(40), 1024)).toBeUndefined();
    expect(await readObject(dir, `${commit}:big.bin`, 100)).toBeUndefined();
    // The reader still answers after refusing.
    expect((await readObject(dir, `${commit}:a.txt`, 1024))?.toString("utf8")).toBe("first\n");
});

test("an index spec follows the index as it moves", async () => {
    await writeFile(join(dir, "a.txt"), "staged\n");
    await sh(dir, "add", "a.txt");
    expect((await readObject(dir, ":0:a.txt", 1024))?.toString("utf8")).toBe("staged\n");
    await writeFile(join(dir, "a.txt"), "staged again\n");
    await sh(dir, "add", "a.txt");
    expect((await readObject(dir, ":0:a.txt", 1024))?.toString("utf8")).toBe("staged again\n");
});
