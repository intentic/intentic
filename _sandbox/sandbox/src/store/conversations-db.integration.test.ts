import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSqlite } from "@intentic/base/sqlite";
import { sqliteTurnCheckpoints } from "../agent/checkpoints/turn-checkpoints.js";
import { sqliteTurnJournal } from "../agent/run/turn/turn-journal.js";
import { sqliteAgentsStore } from "../conversations/registry/agents-store.js";
import { conversationEntry, isolatedAgent } from "../testing.js";
import { CONVERSATIONS_STEPS, conversationsDbPath, openConversationsDb } from "./conversations-db.js";

const historyRoot = (): string => mkdtempSync(join(tmpdir(), "conversations-db-"));

test("what one connection wrote is what the next process opens: a restart loses nothing committed", () => {
    const root = historyRoot();
    const before = openConversationsDb(conversationsDbPath(root));
    const entry = isolatedAgent([{ repo: "root", base: "a" }], { id: "kept" });
    sqliteAgentsStore(before).save([entry]);

    const after = openConversationsDb(conversationsDbPath(root));
    expect(sqliteAgentsStore(after).load()).toEqual([entry]);
    // Write-ahead logged, so a reader never waits on a writer.
    expect(after.db.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
});

test("a snapshot carries every row, and adopting it replaces a conversation of the same id whole", async () => {
    const source = openConversationsDb(conversationsDbPath(historyRoot()));
    const moved = isolatedAgent([{ repo: "root", base: "new" }], { id: "moved" });
    sqliteAgentsStore(source).save([moved, conversationEntry({ id: "only-there" })]);
    await sqliteTurnCheckpoints(source).record("moved", 2, { kind: "tree", snapshot: "s-2" });
    const scratch = mkdtempSync(join(tmpdir(), "conversations-snapshot-"));
    const snapshot = join(scratch, "snapshot.db");
    source.snapshot(snapshot);

    const target = openConversationsDb(conversationsDbPath(historyRoot()));
    const targetAgents = sqliteAgentsStore(target);
    targetAgents.save([
        isolatedAgent(
            [
                { repo: "root", base: "old" },
                { repo: "stale", base: "x" },
            ],
            { id: "moved" },
        ),
        conversationEntry({ id: "only-here" }),
    ]);
    await sqliteTurnCheckpoints(target).record("moved", 9, { kind: "tree", snapshot: "s-9" });
    expect(target.adopt(snapshot)).toEqual(["moved", "only-there"]);

    expect(
        targetAgents
            .load()
            .map((entry) => entry.id)
            .toSorted(),
    ).toEqual(["moved", "only-here", "only-there"]);
    expect(targetAgents.load().find((entry) => entry.id === "moved")).toEqual(moved);
    // The replaced conversation's own rows went with it: only what arrived for it is left.
    expect(await sqliteTurnCheckpoints(target).all("moved")).toEqual(new Map([[2, { kind: "tree", snapshot: "s-2" }]]));
    // One file, standalone: the snapshot needs no WAL beside it to be whole.
    expect(readdirSync(scratch)).toEqual(["snapshot.db"]);
});

test("an arrival from a build whose columns sit in another order lands by column name", () => {
    const root = historyRoot();
    const target = openConversationsDb(conversationsDbPath(root));
    // A source database laid out as another build might have: the same columns, a different order, an extra one.
    const scratch = mkdtempSync(join(tmpdir(), "conversations-arrival-"));
    const arrived = openSqlite(join(scratch, "arrived.db"));
    arrived.exec(`CREATE TABLE conversation (record TEXT NOT NULL, id TEXT PRIMARY KEY, extra TEXT) STRICT;
        CREATE TABLE conversation_repo (conversation_id TEXT, position INTEGER, repo TEXT, base TEXT, landed_tip TEXT, landed_head TEXT, landed_at INTEGER, absorbed INTEGER) STRICT;
        CREATE TABLE checkpoint (conversation_id TEXT, message INTEGER, anchor TEXT) STRICT;
        CREATE TABLE turn_journal (conversation_id TEXT, started_at INTEGER, attempts INTEGER, turn TEXT, session_id TEXT, parked TEXT) STRICT;
        CREATE TABLE watch (id TEXT, conversation_id TEXT, entry TEXT) STRICT;
        CREATE TABLE fire_journal (automation_id TEXT, conversation_id TEXT, started_at INTEGER, attempts INTEGER, payload TEXT, origin TEXT, title TEXT) STRICT;`);
    const entry = conversationEntry({ id: "reordered" });
    arrived.prepare("INSERT INTO conversation (record, id, extra) VALUES (?, ?, ?)").run(JSON.stringify(entry), "reordered", "from a newer build");
    arrived.close();

    expect(target.adopt(join(scratch, "arrived.db"))).toEqual(["reordered"]);
    expect(target.db.prepare("SELECT id FROM conversation").all()).toEqual([{ id: "reordered" }]);
});

// Fires were filed under their automation until threads of one automation could be in flight together; the step that
// files them by conversation moves every fire in flight across, and leaves fire_journal for a rolled-back build.
test("a fire in flight before fires were filed by conversation moves to its conversation, and a build from before still opens", async () => {
    const path = conversationsDbPath(historyRoot());
    // The database as the build before the step left it: the step's table absent, its version one short of the step's.
    const step = CONVERSATIONS_STEPS.findIndex(({ describe }) => describe.includes("fire_journal_by_conversation"));
    const before = openConversationsDb(path);
    before.db.exec(`DROP TABLE fire_journal_by_conversation; PRAGMA user_version = ${step + 1}`);
    const origin = { automationId: "team", provider: "discord", channelId: "c1", threadId: "t1", author: "alice" };
    before.db
        .prepare(
            "INSERT INTO fire_journal(automation_id, conversation_id, started_at, attempts, payload, origin, title, lane, thread, session_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run("team", "a-team-t1", 5, 0, "hi", JSON.stringify(origin), "alice: hi", JSON.stringify({ requireApproval: false }), "discord:team:c1/t1", "sess-1");
    before.db.close();

    const after = openConversationsDb(path);
    expect(await sqliteTurnJournal(after).list()).toEqual([
        {
            kind: "automation",
            automationId: "team",
            conversationId: "a-team-t1",
            startedAt: 5,
            attempts: 0,
            payload: "hi",
            origin,
            title: "alice: hi",
            lane: { requireApproval: false },
            thread: "discord:team:c1/t1",
            sessionId: "sess-1",
        },
    ]);
    expect(after.db.prepare("SELECT count(*) AS n FROM fire_journal").get()).toEqual({ n: 0 });
    // What a build from before the step prepares as it opens the database: a rebuilt fire_journal would refuse it, and
    // that build would not boot after a rollback.
    expect(() =>
        after.db.prepare(
            "INSERT INTO fire_journal(automation_id, conversation_id, started_at, attempts) VALUES (?, ?, ?, ?) ON CONFLICT(automation_id) DO UPDATE SET attempts = excluded.attempts",
        ),
    ).not.toThrow();
});
