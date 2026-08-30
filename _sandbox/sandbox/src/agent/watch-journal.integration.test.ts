import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { fileWatchJournal, type JournalledWatch } from "./watch-journal.js";

const journalDir = (): string => join(mkdtempSync(join(tmpdir(), "watch-journal-")), "watches");

const entryOf = (over: Partial<JournalledWatch> = {}): JournalledWatch => ({
    id: "watch-1",
    conversationId: "conv-1",
    command: "gh run view 316 --json conclusion | grep -q success",
    note: "CI run 316 on intentic/intentic",
    intervalMs: 60_000,
    armedAt: 1_000,
    deadlineAt: 7_201_000,
    cwd: "/work",
    envKeys: ["TOKEN_GITHUB_ABC", "PATH"],
    turn: { agent: "codex", account: "acct-2", isolated: true },
    ...over,
});

test("a watch round-trips, is filed under its own id, and drops independently", async () => {
    const journal = fileWatchJournal(journalDir());
    // The overwhelmingly common boot: nothing was ever armed, so there is no directory to read.
    expect(await journal.list()).toEqual([]);

    await journal.record(entryOf());
    await journal.record(entryOf({ id: "watch-2", note: "deploy", conversationId: "conv-2" }));
    expect((await journal.list()).map((entry) => entry.id).toSorted()).toEqual(["watch-1", "watch-2"]);
    // Verbatim: a restore re-arms from exactly these fields, so a lossy round-trip is a watch that comes back
    // watching something slightly different.
    expect((await journal.list()).find((entry) => entry.id === "watch-1")).toEqual(entryOf());

    await journal.drop("watch-1");
    expect((await journal.list()).map((entry) => entry.id)).toEqual(["watch-2"]);
    // Dropping twice is a no-op: the watch ended and a boot pass already took it, or it never existed.
    await journal.drop("watch-1");
    await journal.drop("watch-404");
    expect((await journal.list()).map((entry) => entry.id)).toEqual(["watch-2"]);
});

test("re-recording the same id replaces it rather than leaving two", async () => {
    const journal = fileWatchJournal(journalDir());
    await journal.record(entryOf({ note: "first" }));
    await journal.record(entryOf({ note: "second" }));
    expect(await journal.list()).toEqual([entryOf({ note: "second" })]);
});

/* A FILE THAT WILL NOT PARSE IS SKIPPED, NEVER DELETED, the turn journal's rule and its reason: an entry
 * caught mid-write reads as garbage for an instant, and a lister that answered that by unlinking would destroy
 * the record of a watch that had only just armed. The cost of keeping it is one failed parse per boot. */
test("skips unreadable and unrecognised files without losing the good ones", async () => {
    const dir = journalDir();
    const journal = fileWatchJournal(dir);
    await journal.record(entryOf());
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "watch-9.json"), "{ half-written");
    // Right shape, wrong contents: a watch with no command could never be checked.
    writeFileSync(join(dir, "watch-8.json"), JSON.stringify({ id: "watch-8", conversationId: "conv-1" }));
    // A filename outside the id charset is never trusted, whatever it contains.
    writeFileSync(join(dir, "../escape.json"), JSON.stringify(entryOf({ id: "escape" })));
    writeFileSync(join(dir, "notes.txt"), "not json at all");

    expect((await journal.list()).map((entry) => entry.id)).toEqual(["watch-1"]);
    // And the unreadable one is still there for a human to look at.
    expect((await journal.list()).length).toBe(1);
});

// The id is a filename, so a drop must not be able to reach outside the directory it owns.
test("refuses to drop through an id that is not a filename", async () => {
    const dir = journalDir();
    const journal = fileWatchJournal(dir);
    await journal.record(entryOf());
    await journal.drop("../watch-1");
    expect((await journal.list()).map((entry) => entry.id)).toEqual(["watch-1"]);
});
