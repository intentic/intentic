import { mkdir, mkdtemp, open, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncParents, writeAll, writeDurable } from "./record-io.js";

let dir: string;
beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "record-io-"));
});
afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

test("retries partial writes without losing or duplicating bytes, including an append", async () => {
    const path = join(dir, "record");
    const bytes = Buffer.from("a whole record, including Unicode: żółw");
    for (let append = 0; append < 2; append += 1) {
        const handle = await open(path, "a");
        try {
            await writeAll({ write: (buffer, offset, length) => handle.write(buffer, offset, Math.min(length, 3)) }, bytes);
            await handle.datasync();
        } finally {
            await handle.close();
        }
    }
    await syncParents(path);
    expect(await readFile(path)).toEqual(Buffer.concat([bytes, bytes]));
});

test("rejects a write that stops making progress instead of acknowledging a partial record", async () => {
    const path = join(dir, "record");
    const handle = await open(path, "w");
    let calls = 0;
    try {
        await expect(writeAll({ write: (bytes, offset, length) => {
            calls += 1;
            return calls === 1 ? handle.write(bytes, offset, Math.min(length, 2)) : Promise.resolve({ bytesWritten: 0 });
        } }, Buffer.from("complete"))).rejects.toThrow("record write made no progress");
    } finally {
        await handle.close();
    }
    expect(calls).toBe(2);
    expect(await readFile(path, "utf8")).toBe("co");
});

test("propagates a directory sync setup failure", async () => {
    await expect(syncParents(join(dir, "missing", "record"))).rejects.toMatchObject({ code: "ENOENT" });
});

test("a durable write puts every chunk down in order, under directories it makes", async () => {
    const path = join(dir, "nested", "record.zst");
    await writeDurable(path, [Buffer.from("one "), Buffer.from("two")]);
    expect(await readFile(path, "utf8")).toBe("one two");
    expect(await readdir(join(dir, "nested"))).toEqual(["record.zst"]);
});

// A blob, a log and a converted record all go down through this one write; a failed rename must not leave its
// temporary beside the record, where nothing would ever reuse or remove it.
test("a durable write whose rename fails leaves no temporary behind", async () => {
    const path = join(dir, "record.zst");
    // A directory holding a file: nothing can be renamed over it.
    await mkdir(path);
    await writeFile(join(path, "occupied"), "");
    await expect(writeDurable(path, [Buffer.from("bytes")])).rejects.toThrow();
    expect(await readdir(dir)).toEqual(["record.zst"]);
});

test("a durable write whose bytes fail to land leaves no temporary behind", async () => {
    const path = join(dir, "record.zst");
    const failing = (function* () {
        yield Buffer.from("half");
        throw new Error("compression failed");
    })();
    await expect(writeDurable(path, failing)).rejects.toThrow("compression failed");
    expect(await readdir(dir)).toEqual([]);
});
