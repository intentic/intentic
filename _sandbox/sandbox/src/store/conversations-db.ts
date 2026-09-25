import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { headerSchemaVersion, migrateSqlite, type SqliteStep, targetVersion } from "./evolution/sqlite-migrations.js";
import { openSqlite, transaction } from "./sqlite.js";
import { defineStep } from "./evolution/state-steps.js";

// The daemon's operational state that must agree with itself, one database beside the conversation units: the registry,
// and everything keyed by a conversation that must go when it goes, each such row cascading from its conversation's.
// Its schema evolves by numbered steps (sqlite-migrations.ts): SCHEMA below is version 1, CONVERSATIONS_STEPS every
// version after it, append-only, each adding what an older build can ignore.

// Its file on the history volume. Live, a WAL database is this file and its `-wal` and `-shm` siblings together, which is
// why nothing copies it as files (`snapshot`).
export const conversationsDbPath = (historyRoot: string): string => join(historyRoot, "conversations.db");

// Parent before child, the order rows are copied in and the order a reader walks them.
export const CONVERSATION_TABLES = ["conversation", "conversation_repo", "checkpoint", "turn_journal", "watch", "fire_journal"] as const;

const SCHEMA = `
/* One row per conversation: its registry record (agents-store.ts) as JSON, less the repos its checkout carries. */
CREATE TABLE IF NOT EXISTS conversation (
    id TEXT PRIMARY KEY,
    record TEXT NOT NULL CHECK (json_valid(record))
) STRICT;

/* A worktree conversation's checkout per repo: the main-line base its branch stands on and the last land's provenance. */
CREATE TABLE IF NOT EXISTS conversation_repo (
    conversation_id TEXT NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    repo TEXT NOT NULL,
    base TEXT NOT NULL,
    landed_tip TEXT,
    landed_head TEXT,
    landed_at INTEGER,
    absorbed INTEGER,
    PRIMARY KEY (conversation_id, repo)
) STRICT;

/* What each of its messages can be put back to (turn-checkpoints.ts), by the message's position in the transcript. */
CREATE TABLE IF NOT EXISTS checkpoint (
    conversation_id TEXT NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
    message INTEGER NOT NULL,
    anchor TEXT NOT NULL CHECK (json_valid(anchor)),
    PRIMARY KEY (conversation_id, message)
) STRICT;

/* Its turn in flight, written with the entry that opens it and deleted once the turn's transcript is down. */
CREATE TABLE IF NOT EXISTS turn_journal (
    conversation_id TEXT PRIMARY KEY REFERENCES conversation(id) ON DELETE CASCADE,
    started_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL,
    turn TEXT NOT NULL CHECK (json_valid(turn)),
    session_id TEXT,
    parked TEXT CHECK (parked IS NULL OR json_valid(parked))
) STRICT;

/* Its armed or firing condition watches (watch-journal.ts). */
CREATE TABLE IF NOT EXISTS watch (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
    entry TEXT NOT NULL CHECK (json_valid(entry))
) STRICT;
CREATE INDEX IF NOT EXISTS watch_conversation ON watch(conversation_id);

/* An automation's fire in flight. Owned by the automation, not the conversation: the fire is journalled before the
   conversation it opens exists, so nothing references a conversation row here. */
CREATE TABLE IF NOT EXISTS fire_journal (
    automation_id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL,
    payload TEXT,
    origin TEXT CHECK (origin IS NULL OR json_valid(origin)),
    title TEXT
) STRICT;
`;

// Every schema change after the baseline, in order; the database's `user_version` says how many it has taken.
export const CONVERSATIONS_STEPS: readonly SqliteStep[] = [];

// The upgrade runs in the boot step (store/evolution/state-convergence.ts), under its journal, with the database and its sidecars
// copied aside first, so a rolled-back build gets back the file it knew. Opening the database below takes any step
// this missed (a guest, a failed boot step), as every SQLite program does.
export const conversationsSchemaStep = defineStep({
    id: "conversations-db-schema",
    describe: "upgrades the conversations database schema",
    plan: async ({ roots }) => {
        const path = conversationsDbPath(roots.history);
        const from = await headerSchemaVersion(path);
        const to = targetVersion(CONVERSATIONS_STEPS);
        if (from === undefined || Math.max(from, 1) >= to) {
            return undefined;
        }
        return {
            changes: CONVERSATIONS_STEPS.slice(Math.max(from, 1) - 1).map((step) => step.describe),
            writes: new Map(),
            touches: [path, `${path}-wal`, `${path}-shm`],
            effect: () => {
                const db = openSqlite(path);
                try {
                    migrateSqlite(db, SCHEMA, CONVERSATIONS_STEPS);
                } finally {
                    db.close();
                }
                return Promise.resolve();
            },
        };
    },
});

export interface ConversationsDb {
    readonly db: DatabaseSync;
    // All of `work` or none of it, over this database (sqlite.ts).
    readonly transaction: <T>(work: () => T) => T;
    // A consistent copy of the whole database at `path` while writers carry on, which a file copy of a WAL database is
    // not; what an export packs.
    readonly snapshot: (path: string) => void;
    // Whether no table holds a row: a volume nothing has happened on yet, whose database an export need not carry.
    readonly empty: () => boolean;
    // Every row of the database at `path` into this one, replacing a conversation that has the same id with the whole of
    // what arrived for it; what an arrival lands. The arrived copy is brought to this build's schema first and copied
    // by column name, so a bundle from another version lands whatever its columns' order. Answers the ids of the
    // conversations that arrived.
    readonly adopt: (path: string) => string[];
    // Every row naming the conversation in any table, by table, found by reading the schema rather than knowing it: the
    // `conversation` row by its id, every other by its `conversation_id`. What a person diagnosing one reads.
    readonly rowsOf: (conversationId: string) => Record<string, Record<string, unknown>[]>;
}

// A stored JSON column read back as the value it holds; every other column as stored.
const readable = (row: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(
        Object.entries(row).map(([column, value]) => [column, typeof value === "string" && /^[[{]/.test(value) ? JSON.parse(value) : value]),
    );

// Columns a table has in both databases, by name: what an arrival can copy across two builds' schemas.
const sharedColumns = (db: DatabaseSync, table: string): string[] => {
    const inSchema = (schema: string): string[] =>
        (db.prepare("SELECT name FROM pragma_table_info(?, ?)").all(table, schema) as { name: string }[]).map(({ name }) => name);
    const arrived = new Set(inSchema("arrived"));
    return inSchema("main").filter((name) => arrived.has(name));
};

export const openConversationsDb = (path: string): ConversationsDb => {
    const db = openSqlite(path);
    migrateSqlite(db, SCHEMA, CONVERSATIONS_STEPS);
    const tx = <T>(work: () => T): T => transaction(db, work);
    const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
    const columns = db.prepare("SELECT name FROM pragma_table_info(?)");
    // The column that names a conversation in each table, where one does.
    const keyOf = (table: string): string | undefined =>
        table === "conversation" ? "id" : (columns.all(table) as { name: string }[]).some(({ name }) => name === "conversation_id") ? "conversation_id" : undefined;
    return {
        db,
        transaction: tx,
        snapshot: (target) => {
            db.prepare("VACUUM INTO ?").run(target);
        },
        empty: () => (tables.all() as { name: string }[]).every(({ name }) => db.prepare(`SELECT 1 FROM "${name}" LIMIT 1`).get() === undefined),
        adopt: (source) => {
            // The arrival is a copy the bundle unpacked for this, so it may be upgraded in place before it is read. Opened in
            // its own journal mode, not the WAL a live database runs in, so the copy stays one standalone file.
            const arrivedDb = new DatabaseSync(source);
            try {
                migrateSqlite(arrivedDb, SCHEMA, CONVERSATIONS_STEPS);
            } finally {
                arrivedDb.close();
            }
            // Outside any transaction, which SQLite requires of ATTACH and DETACH alike.
            db.prepare("ATTACH DATABASE ? AS arrived").run(source);
            try {
                return tx(() => {
                    // The cascade takes every row the arriving conversation replaces, so none of the old one survives it.
                    db.exec("DELETE FROM main.conversation WHERE id IN (SELECT id FROM arrived.conversation)");
                    db.exec("DELETE FROM main.fire_journal WHERE automation_id IN (SELECT automation_id FROM arrived.fire_journal)");
                    for (const table of CONVERSATION_TABLES) {
                        const shared = sharedColumns(db, table)
                            .map((name) => `"${name}"`)
                            .join(", ");
                        db.exec(`INSERT INTO main.${table} (${shared}) SELECT ${shared} FROM arrived.${table}`);
                    }
                    return (db.prepare("SELECT id FROM arrived.conversation ORDER BY id").all() as { id: string }[]).map(({ id }) => id);
                });
            } finally {
                db.exec("DETACH DATABASE arrived");
            }
        },
        rowsOf: (conversationId) =>
            Object.fromEntries(
                (tables.all() as { name: string }[]).flatMap(({ name }) => {
                    const key = keyOf(name);
                    const rows = key === undefined ? [] : (db.prepare(`SELECT * FROM "${name}" WHERE "${key}" = ?`).all(conversationId) as Record<string, unknown>[]);
                    return rows.length === 0 ? [] : [[name, rows.map(readable)]];
                }),
            ),
    };
};
