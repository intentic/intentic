import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncParents, writeAll } from "./record-io.js";

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
