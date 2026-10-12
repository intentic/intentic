import { link, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { activityLogDocument } from "../activity/activity-store.js";
import { stateDocuments } from "../bootstrap/state-registry.js";
import { usageLedgerDocument } from "../usage/usage-store.js";
import { rename } from "./evolution/conversions.js";
import { defineDocument } from "./evolution/documents.js";
import { queueOnFile } from "@intentic/base/fs";
import { lineLog, openLedger } from "./open-document.js";

// A JSON Lines ledger is appended a line at a time and read whole, every line through its document: the conversions a
// shape change ships with, then the schema. The money ledger and the audit log are two of these, and a ledger with no
// document is one whose shape can change with nothing to convert what it already holds.

let dir = "";

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ledger-"));
});

afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

const ledgerDocument = defineDocument({
    root: "history",
    path: "test.jsonl",
    schema: z.object({ amount: z.number() }),
    granularity: "entries",
    boot: false,
    history: [rename("cost", "amount")],
});

const uncapped = { cap: "never" } as const;

test("every line reads through the document's conversions, whichever build wrote it", async () => {
    const path = join(dir, "test.jsonl");
    await writeFile(path, `${JSON.stringify({ cost: 1 })}\n${JSON.stringify({ amount: 2 })}\n`);
    const ledger = openLedger(ledgerDocument, path, uncapped);
    await ledger.append({ amount: 3 });
    expect(await ledger.read()).toEqual([{ amount: 1 }, { amount: 2 }, { amount: 3 }]);
    // Appended, never rewritten: the line an older build wrote stays as it was.
    expect((await readFile(path, "utf8")).split("\n")[0]).toBe(JSON.stringify({ cost: 1 }));
});

test("a torn line or one this build cannot read costs itself, never the ledger", async () => {
    const path = join(dir, "test.jsonl");
    await writeFile(path, `${JSON.stringify({ amount: 1 })}\n{torn\n${JSON.stringify({ amount: "many" })}\n${JSON.stringify({ amount: 4 })}\n`);
    expect(await openLedger(ledgerDocument, path, uncapped).read()).toEqual([{ amount: 1 }, { amount: 4 }]);
});

test("a line torn by a crash costs only itself: the next process's first line starts a line of its own", async () => {
    const path = join(dir, "test.jsonl");
    await writeFile(path, `${JSON.stringify({ amount: 1 })}\n{"amou`);
    const ledger = openLedger(ledgerDocument, path, uncapped);
    await Promise.all([ledger.append({ amount: 2 }), openLedger(ledgerDocument, path, uncapped).append({ amount: 3 })]);
    await ledger.append({ amount: 4 });
    expect((await ledger.read()).map(({ amount }) => amount).toSorted()).toEqual([1, 2, 3, 4]);
    // One newline ends the fragment, however many handles appended first.
    expect((await readFile(path, "utf8")).split("\n")).toHaveLength(6);
});

test("an absent ledger is empty, and one that cannot be read says so", async () => {
    expect(await openLedger(ledgerDocument, join(dir, "test.jsonl"), uncapped).read()).toEqual([]);
    // A directory where the ledger should be: unreadable, never read as no entries.
    await expect(openLedger(ledgerDocument, dir, uncapped).read()).rejects.toThrow(/EISDIR/);
});

test("the money ledger and the activity log are stored documents the boot and the shape check both know", () => {
    expect(stateDocuments()).toEqual(expect.arrayContaining([usageLedgerDocument, activityLogDocument]));
    expect([usageLedgerDocument, activityLogDocument].map((spec) => [spec.root, spec.path, spec.granularity, spec.boot])).toEqual([
        ["history", "usage.jsonl", "entries", false],
        ["history", "activity.jsonl", "entries", false],
    ]);
});

/* EVERY HANDLE ON ONE PATH SHARES ONE QUEUE, because two stores each serializing only their own appends still tore a line. */
// Lines past the size one write call is sure to take whole, so an unqueued pair would interleave their pieces.
const wideDocument = defineDocument({
    root: "history",
    path: "wide.jsonl",
    schema: z.object({ amount: z.number(), pad: z.string() }),
    granularity: "entries",
    boot: false,
});

test("concurrent appends from two handles on one path never interleave", async () => {
    const path = join(dir, "wide.jsonl");
    const handles = [openLedger(wideDocument, path, uncapped), openLedger(wideDocument, path, uncapped)];
    const pad = "x".repeat(256 * 1024);
    await Promise.all(Array.from({ length: 20 }, (_, amount) => handles[amount % 2]?.append({ amount, pad })));
    expect((await readFile(path, "utf8")).split("\n").filter((line) => line !== "")).toHaveLength(20);
    const read = await openLedger(wideDocument, path, uncapped).read();
    expect(read.map(({ amount }) => amount).toSorted((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, amount) => amount));
    expect(read.every((entry) => entry.pad === pad)).toBe(true);
});

/* A CAPPED LEDGER FORGETS ITS OLDEST LINES, because an audit trail grew without bound; a money log names "never". */
test("past its cap a ledger keeps its newest lines, replaced whole by a rename, and says it pruned", async () => {
    const path = join(dir, "test.jsonl");
    await writeFile(path, Array.from({ length: 100 }, (_, amount) => `${JSON.stringify({ amount })}\n`).join(""));
    // A second name for the ledger as it was: a prune that rewrote it in place would show through this link too.
    await link(path, `${path}.before`);
    const ledger = openLedger(ledgerDocument, path, { cap: { overBytes: 1_000, keepLines: 10 } });

    expect(await ledger.append({ amount: 100 })).toEqual({ pruned: true });
    expect((await ledger.read()).map(({ amount }) => amount)).toEqual(Array.from({ length: 10 }, (_, index) => 91 + index));
    expect((await readFile(`${path}.before`, "utf8")).split("\n").filter((line) => line !== "")).toHaveLength(101);
    // Under its cap again, the next append leaves it be.
    expect(await ledger.append({ amount: 101 })).toEqual({ pruned: false });
    expect(await ledger.read()).toHaveLength(11);
});

test("a byte cap keeps the newest whole lines that fit, never the remains of one cut through", async () => {
    const path = join(dir, "test.jsonl");
    const line = (amount: number): string => `${JSON.stringify({ amount: 1_000 + amount })}\n`;
    // Fifteen bytes a line.
    await writeFile(path, Array.from({ length: 100 }, (_, index) => line(index)).join(""));
    const log = lineLog(path, { cap: { overBytes: 1_000, keepBytes: 100 } });
    expect(await log.append(JSON.stringify({ amount: 2_000 }))).toEqual({ pruned: true });
    const text = await readFile(path, "utf8");
    // 100 bytes hold six whole lines and the tail of a seventh, which is dropped.
    expect(text).toBe(`${[95, 96, 97, 98, 99].map((index) => line(index)).join("")}${JSON.stringify({ amount: 2_000 })}\n`);
});

test("a ledger capped never is never cut, however far past any size it grows", async () => {
    const path = join(dir, "test.jsonl");
    await writeFile(path, `${JSON.stringify({ amount: 0 })}\n`.repeat(100_000));
    const ledger = openLedger(ledgerDocument, path, uncapped);
    expect(await ledger.append({ amount: 1 })).toEqual({ pruned: false });
    expect(await ledger.read()).toHaveLength(100_001);
});

test("appends racing a prune from two handles are all kept, after it or in it", async () => {
    const path = join(dir, "test.jsonl");
    // Every append past the first takes it over the cap, and the cap keeps every line, so each one lost is one a prune
    // renamed away while another handle was appending to the file it replaced.
    const cap = { cap: { overBytes: 1, keepLines: 1_000 } } as const;
    const handles = [openLedger(ledgerDocument, path, cap), openLedger(ledgerDocument, path, cap)];
    await Promise.all(Array.from({ length: 100 }, (_, amount) => handles[amount % 2]?.append({ amount })));
    expect((await handles[0]?.read())?.map(({ amount }) => amount).toSorted((a, b) => a - b)).toEqual(Array.from({ length: 100 }, (_, amount) => amount));
});

test("an append waits its turn in the path's own queue, the one every handle and writer of that path shares", async () => {
    const path = join(dir, "test.jsonl");
    const { promise: gate, resolve: open } = Promise.withResolvers<void>();
    const holding = queueOnFile(path, () => gate);
    const appended = openLedger(ledgerDocument, path, uncapped).append({ amount: 1 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await openLedger(ledgerDocument, path, uncapped).read()).toEqual([]);
    open();
    await holding;
    await appended;
    expect(await openLedger(ledgerDocument, path, uncapped).read()).toEqual([{ amount: 1 }]);
});
