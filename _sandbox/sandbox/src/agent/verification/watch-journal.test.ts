import { WORKSPACE_ROOT } from "@intentic/constants";
import { expect, test } from "bun:test";
import { sqliteAgentsStore } from "../../agents/registry/agents-store.js";
import { openConversationsDb } from "../../store/conversations-db.js";
import { IN_MEMORY } from "../../store/sqlite.js";
import { conversationEntry } from "../../testing.js";
import { type JournalledWatch, sqliteWatchJournal } from "./watch-journal.js";

const registered = (...ids: string[]) => {
    const db = openConversationsDb(IN_MEMORY);
    sqliteAgentsStore(db).save(ids.map((id) => conversationEntry({ id })));
    return { db, journal: sqliteWatchJournal(db) };
};

const entryOf = (over: Partial<JournalledWatch> = {}): JournalledWatch => ({
    id: "watch-1",
    conversationId: "conv-1",
    command: "gh run view 316 --json conclusion | grep -q success",
    note: "CI run 316 on intentic/intentic",
    intervalMs: 60_000,
    armedAt: 1_000,
    deadlineAt: 7_201_000,
    cwd: WORKSPACE_ROOT,
    envKeys: ["TOKEN_GITHUB_ABC", "PATH"],
    turn: { agent: "codex", account: "acct-2", isolated: true },
    ...over,
});

test("a watch round-trips verbatim, is filed under its own id, and drops independently", async () => {
    const { journal } = registered("conv-1", "conv-2");
    // The overwhelmingly common boot: nothing was ever armed.
    expect(await journal.list()).toEqual([]);

    const firing = entryOf({ firing: { outcome: "met", check: { exitCode: 0, output: "success" } }, placement: { worktree: "/wt/conv-1", fenced: true } });
    await journal.record(firing);
    const signalled = entryOf({ id: "watch-2", note: "deploy", conversationId: "conv-2", signalPath: "/tmp/intentic-run-job-2/status" });
    await journal.record(signalled);
    // Verbatim: a restore re-arms from exactly these fields, so a lossy round-trip changes what it watches.
    expect(await journal.list()).toEqual([firing, signalled]);

    await journal.drop("watch-1");
    expect((await journal.list()).map((entry) => entry.id)).toEqual(["watch-2"]);
    // Dropping twice is a no-op: the watch ended and a boot pass already took it, or it never existed.
    await journal.drop("watch-1");
    await journal.drop("watch-404");
    expect((await journal.list()).map((entry) => entry.id)).toEqual(["watch-2"]);
});

test("re-recording the same id replaces it rather than leaving two", async () => {
    const { journal } = registered("conv-1");
    await journal.record(entryOf({ note: "first" }));
    await journal.record(entryOf({ note: "second" }));
    expect(await journal.list()).toEqual([entryOf({ note: "second" })]);
});

// A row that will not parse is skipped, never deleted: it may be a watch this build merely cannot read.
test("skips a row it cannot read without losing the good ones", async () => {
    const { db, journal } = registered("conv-1");
    await journal.record(entryOf());
    db.db.prepare("INSERT INTO watch(id, conversation_id, entry) VALUES ('watch-8', 'conv-1', '{}')").run();
    expect((await journal.list()).map((entry) => entry.id)).toEqual(["watch-1"]);
    expect(db.rowsOf("conv-1")["watch"]?.map((row) => row["id"])).toEqual(["watch-1", "watch-8"]);
});

test("a watch belongs to a registered conversation, and goes with it", async () => {
    const { db, journal } = registered("conv-1");
    await expect(journal.record(entryOf({ conversationId: "conv-unknown" }))).rejects.toThrow("FOREIGN KEY constraint failed");
    await journal.record(entryOf());
    sqliteAgentsStore(db).remove(["conv-1"]);
    expect(await journal.list()).toEqual([]);
});
