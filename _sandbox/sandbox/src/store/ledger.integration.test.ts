import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { activityLogDocument } from "../activity/activity-store.js";
import { stateDocuments } from "../bootstrap/state-registry.js";
import { usageLedgerDocument } from "../usage/usage-store.js";
import { rename } from "./evolution/conversions.js";
import { defineDocument } from "./evolution/documents.js";
import { openLedger } from "./open-document.js";

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

test("every line reads through the document's conversions, whichever build wrote it", async () => {
    const path = join(dir, "test.jsonl");
    await writeFile(path, `${JSON.stringify({ cost: 1 })}\n${JSON.stringify({ amount: 2 })}\n`);
    const ledger = openLedger(ledgerDocument, path);
    await ledger.append({ amount: 3 });
    expect(await ledger.read()).toEqual([{ amount: 1 }, { amount: 2 }, { amount: 3 }]);
    // Appended, never rewritten: the line an older build wrote stays as it was.
    expect((await readFile(path, "utf8")).split("\n")[0]).toBe(JSON.stringify({ cost: 1 }));
});

test("a torn line or one this build cannot read costs itself, never the ledger", async () => {
    const path = join(dir, "test.jsonl");
    await writeFile(path, `${JSON.stringify({ amount: 1 })}\n{torn\n${JSON.stringify({ amount: "many" })}\n${JSON.stringify({ amount: 4 })}\n`);
    expect(await openLedger(ledgerDocument, path).read()).toEqual([{ amount: 1 }, { amount: 4 }]);
});

test("a line torn by a crash costs only itself: the next process's first line starts a line of its own", async () => {
    const path = join(dir, "test.jsonl");
    await writeFile(path, `${JSON.stringify({ amount: 1 })}\n{"amou`);
    const ledger = openLedger(ledgerDocument, path);
    await Promise.all([ledger.append({ amount: 2 }), openLedger(ledgerDocument, path).append({ amount: 3 })]);
    await ledger.append({ amount: 4 });
    expect((await ledger.read()).map(({ amount }) => amount).toSorted()).toEqual([1, 2, 3, 4]);
    // One newline ends the fragment, however many handles appended first.
    expect((await readFile(path, "utf8")).split("\n")).toHaveLength(6);
});

test("an absent ledger is empty, and one that cannot be read says so", async () => {
    expect(await openLedger(ledgerDocument, join(dir, "test.jsonl")).read()).toEqual([]);
    // A directory where the ledger should be: unreadable, never read as no entries.
    await expect(openLedger(ledgerDocument, dir).read()).rejects.toThrow(/EISDIR/);
});

test("the money ledger and the activity log are stored documents the boot and the shape check both know", () => {
    expect(stateDocuments()).toEqual(expect.arrayContaining([usageLedgerDocument, activityLogDocument]));
    expect([usageLedgerDocument, activityLogDocument].map((spec) => [spec.root, spec.path, spec.granularity, spec.boot])).toEqual([
        ["history", "usage.jsonl", "entries", false],
        ["history", "activity.jsonl", "entries", false],
    ]);
});
