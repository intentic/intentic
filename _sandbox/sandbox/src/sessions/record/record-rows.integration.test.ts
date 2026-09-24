import { mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TranscriptRow } from "@intentic/sandbox-contract";
import { blobsRoot, getBlob, putBlob, sweepBlobs } from "./record-blobs.js";
import { blobNamesIn, callsOf, keptLine, PAGE_TEXT_CAP, previewOf, wholeOf } from "./record-rows.js";

// A row as kept and as read back: long outputs out of line at every depth, a page seeing only their start, and a whole
// read the row exactly as it was.

let historyRoot: string;
beforeEach(async () => {
    historyRoot = await mkdtemp(join(tmpdir(), "intentic-record-rows-"));
});
afterEach(async () => {
    await rm(historyRoot, { recursive: true, force: true });
});

const long = (seed: string): string => seed.repeat(20_000);

const row: TranscriptRow = {
    role: "assistant",
    text: "done",
    tools: [
        {
            id: "t1",
            name: "Bash",
            category: "execute",
            status: "completed",
            target: "ls",
            content: [
                { type: "text", text: long("a") },
                { type: "text", text: "short" },
            ],
            children: [{ id: "t2", name: "Read", category: "read", status: "completed", target: "b", content: [{ type: "text", text: long("b") }] }],
        },
    ],
};

test("keeps long outputs out of line at every depth, and reads the row back exactly as it was", async () => {
    const line = await keptLine(row, (text) => putBlob(historyRoot, text));
    expect(line.length).toBeLessThan(3 * PAGE_TEXT_CAP);
    const stored = JSON.parse(line) as unknown;
    expect(blobNamesIn(line)).toHaveLength(2);
    expect(await wholeOf(stored, (hash) => getBlob(historyRoot, hash))).toEqual(row);
});

test("a page reads each out-of-line output as the start it kept, and a delegation as the count a page shows", async () => {
    const stored = JSON.parse(await keptLine(row, (text) => putBlob(historyRoot, text))) as unknown;
    const preview = previewOf(stored) as TranscriptRow;
    const [first] = preview.tools ?? [];
    expect(first?.content?.[0]).toEqual({ type: "text", text: long("a").slice(0, PAGE_TEXT_CAP) });
    expect(first?.content?.[1]).toEqual({ type: "text", text: "short" });
    expect(first?.children).toBeUndefined();
    expect(first?.nested).toBe(1);
});

test("opening a delegation reads its calls back, each output the start its parent's page shows", async () => {
    const stored = JSON.parse(await keptLine(row, (text) => putBlob(historyRoot, text))) as unknown;
    const opened = (await callsOf(stored, (hash) => getBlob(historyRoot, hash))) as TranscriptRow;
    const [first] = opened.tools ?? [];
    expect(first?.children?.[0]?.content).toEqual([{ type: "text", text: long("b") }]);
    expect(first?.content?.[0]).toEqual({ type: "text", text: long("a").slice(0, PAGE_TEXT_CAP) });
});

test("a sweep removes only the blobs nothing names, none in use and none named within the grace", async () => {
    const kept = await putBlob(historyRoot, long("k"));
    const orphan = await putBlob(historyRoot, long("o"));
    const busy = await putBlob(historyRoot, long("b"));
    expect(await sweepBlobs(historyRoot, new Set([kept]), () => false, Date.now(), 60_000)).toBe(0);
    expect(await sweepBlobs(historyRoot, new Set([kept]), (hash) => hash === busy, Date.now() + 120_000, 60_000)).toBe(1);
    expect(await getBlob(historyRoot, kept)).toBe(long("k"));
    expect(await getBlob(historyRoot, busy)).toBe(long("b"));
    expect(await getBlob(historyRoot, orphan)).toBeUndefined();
});

test("a blob a write starts naming while the sweep sets it aside is put back", async () => {
    const hash = await putBlob(historyRoot, long("w"));
    let asked = 0;
    // Unused when the sweep first looks, in use by the time it has set the blob aside.
    const inUse = (): boolean => {
        asked += 1;
        return asked > 1;
    };
    expect(await sweepBlobs(historyRoot, new Set(), inUse, Date.now() + 120_000, 60_000)).toBe(0);
    expect(await getBlob(historyRoot, hash)).toBe(long("w"));
    expect((await readdir(join(blobsRoot(historyRoot), hash.slice(0, 2)))).toSorted()).toEqual([`${hash}.zst`]);
});

test("a blob stored again is named again, so a sweep reads it as young", async () => {
    const hash = await putBlob(historyRoot, long("y"));
    const path = join(blobsRoot(historyRoot), hash.slice(0, 2), `${hash}.zst`);
    const longAgo = new Date(Date.now() - 3_600_000);
    await utimes(path, longAgo, longAgo);
    await putBlob(historyRoot, long("y"));
    expect(await sweepBlobs(historyRoot, new Set(), () => false, Date.now(), 60_000)).toBe(0);
    expect(await getBlob(historyRoot, hash)).toBe(long("y"));
});

test("a sweep clears what crashed writes left behind once they are as old as the grace", async () => {
    const hash = await putBlob(historyRoot, long("c"));
    const dir = join(blobsRoot(historyRoot), hash.slice(0, 2));
    await writeFile(join(dir, `${hash}.zst.0b1c.tmp`), "half");
    expect(await sweepBlobs(historyRoot, new Set([hash]), () => false, Date.now() + 120_000, 60_000)).toBe(1);
    expect(await readdir(dir)).toEqual([`${hash}.zst`]);
});
