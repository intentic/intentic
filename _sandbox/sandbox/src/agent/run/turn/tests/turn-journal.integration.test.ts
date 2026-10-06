import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sqliteAgentsStore } from "../../../../conversations/registry/agents-store.js";
import { conversationsDbPath, openConversationsDb } from "../../../../store/conversations-db.js";
import { conversationEntry } from "../../../../testing.js";
import { sqliteTurnJournal } from "../turn-journal.js";

// What the journal is for: the daemon that dies under a turn is not the one that reads the entry back.
test("a turn and a fire in flight are what the next daemon's boot finds", async () => {
    const root = mkdtempSync(join(tmpdir(), "journal-"));
    const dying = openConversationsDb(conversationsDbPath(root));
    sqliteAgentsStore(dying).save([conversationEntry({ id: "c-1" })]);
    await sqliteTurnJournal(dying).recordTurn({
        kind: "turn",
        turn: { conversationId: "c-1", prompt: "ship it" },
        sessionId: "sess-1",
        startedAt: 10,
        attempts: 0,
    });
    await sqliteTurnJournal(dying).recordFire({
        kind: "automation",
        automationId: "nightly",
        conversationId: "a-nightly-1",
        startedAt: 20,
        attempts: 0,
    });

    const booted = sqliteTurnJournal(openConversationsDb(conversationsDbPath(root)));
    expect(await booted.list()).toEqual([
        { kind: "turn", turn: { conversationId: "c-1", prompt: "ship it" }, sessionId: "sess-1", startedAt: 10, attempts: 0 },
        { kind: "automation", automationId: "nightly", conversationId: "a-nightly-1", startedAt: 20, attempts: 0 },
    ]);
});

// A turn parked on a person comes back as the run it was (turn-resume.ts, carriedRun), so its id and the rows it drew
// are what the next daemon's boot must find with its cards.
test("a parked turn's run, rows and all, is what the next daemon's boot finds", async () => {
    const root = mkdtempSync(join(tmpdir(), "journal-"));
    const dying = openConversationsDb(conversationsDbPath(root));
    sqliteAgentsStore(dying).save([conversationEntry({ id: "c-1" })]);
    const run = { id: "run-1", rows: [{ role: "user" as const, text: "ship it", sentAt: 10, run: "run-1" }] };
    await sqliteTurnJournal(dying).recordTurn({ kind: "turn", turn: { conversationId: "c-1", prompt: "ship it" }, startedAt: 10, attempts: 0, run });

    const [entry] = await sqliteTurnJournal(openConversationsDb(conversationsDbPath(root))).list();
    expect(entry).toMatchObject({ kind: "turn", startedAt: 10, run });
});

// A build that does not write the column leaves it standing under the next turn it journals; that turn is not this run.
test("a run journalled under another start is not taken for the turn the row now holds", async () => {
    const root = mkdtempSync(join(tmpdir(), "journal-"));
    const db = openConversationsDb(conversationsDbPath(root));
    sqliteAgentsStore(db).save([conversationEntry({ id: "c-1" })]);
    await sqliteTurnJournal(db).recordTurn({
        kind: "turn",
        turn: { conversationId: "c-1", prompt: "first" },
        startedAt: 10,
        attempts: 0,
        run: { id: "run-1" },
    });
    // What an older build's upsert leaves: every column it knows rewritten, `run` untouched.
    db.db
        .prepare("UPDATE turn_journal SET started_at = 20, turn = ? WHERE conversation_id = 'c-1'")
        .run(JSON.stringify({ conversationId: "c-1", prompt: "second" }));

    const [entry] = await sqliteTurnJournal(db).list();
    expect(entry).toEqual({ kind: "turn", turn: { conversationId: "c-1", prompt: "second" }, startedAt: 20, attempts: 0 });
});

// Rows a later build can no longer read cost only themselves: the entry, its cards and its run's id still come back.
test("a run whose rows no longer read keeps its id, and the entry still comes back", async () => {
    const root = mkdtempSync(join(tmpdir(), "journal-"));
    const db = openConversationsDb(conversationsDbPath(root));
    sqliteAgentsStore(db).save([conversationEntry({ id: "c-1" })]);
    await sqliteTurnJournal(db).recordTurn({ kind: "turn", turn: { conversationId: "c-1", prompt: "ship it" }, startedAt: 10, attempts: 0 });
    db.db
        .prepare("UPDATE turn_journal SET run = ? WHERE conversation_id = 'c-1'")
        .run(JSON.stringify({ id: "run-1", startedAt: 10, rows: [{ role: "robot" }] }));

    const [entry] = await sqliteTurnJournal(db).list();
    expect(entry).toEqual({ kind: "turn", turn: { conversationId: "c-1", prompt: "ship it" }, startedAt: 10, attempts: 0, run: { id: "run-1" } });
});
