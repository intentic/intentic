import { mkdtemp, open, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordBlobNames } from "./record-blob-names.js";
import { appendLog, writeLog } from "./record-log.js";

// The names a blob sweep reads from each record, against real record files: a record at rest is answered without being
// decoded again, and one that changed is read again.

let dir: string;
beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "intentic-record-names-"));
});
afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

const blob = (char: string): string => char.repeat(64);
const naming = (hash: string): string => JSON.stringify({ role: "assistant", tools: [{ content: [{ type: "text", blob: hash }] }] });

// The file's bytes overwritten in place, its size and times put back: a record that reads as unchanged, whose bytes are
// no longer a log, so reading it again finds no frame and no name in it.
const scrambleInPlace = async (path: string): Promise<void> => {
    const before = await stat(path);
    const handle = await open(path, "r+");
    try {
        await handle.write(Buffer.alloc(before.size, 0x41), 0, before.size, 0);
    } finally {
        await handle.close();
    }
    await utimes(path, before.atime, before.mtime);
};

test("a record unchanged since the last sweep is answered without decoding it again", async () => {
    const path = join(dir, "record.jsonl.zst");
    await writeLog(path, [[naming(blob("a")), "{}"], [naming(blob("b"))]]);
    // Whole seconds, so putting the times back after the scramble restores them exactly.
    await utimes(path, 1_700_000_000, 1_700_000_000);
    const names = recordBlobNames();

    expect([...(await names.namesOf(path))].sort()).toEqual([blob("a"), blob("b")]);
    await scrambleInPlace(path);
    expect([...(await names.namesOf(path))].sort()).toEqual([blob("a"), blob("b")]);
});

test("a record that grew is read again, and one that is gone names nothing", async () => {
    const path = join(dir, "record.jsonl.zst");
    await writeLog(path, [[naming(blob("a"))]]);
    const names = recordBlobNames();
    expect(await names.namesOf(path)).toEqual([blob("a")]);

    await appendLog(path, undefined, [naming(blob("c"))]);
    expect([...(await names.namesOf(path))].sort()).toEqual([blob("a"), blob("c")]);

    await rm(path);
    expect(await names.namesOf(path)).toEqual([]);
    expect(await names.namesOf(join(dir, "never.jsonl.zst"))).toEqual([]);
});

test("a record the sweep no longer found is forgotten, and read again if it comes back", async () => {
    const path = join(dir, "record.jsonl.zst");
    await writeLog(path, [[naming(blob("a"))]]);
    await utimes(path, 1_700_000_000, 1_700_000_000);
    const names = recordBlobNames();
    await names.namesOf(path);

    names.keepOnly(new Set());
    await scrambleInPlace(path);
    expect(await names.namesOf(path)).toEqual([]);
});
