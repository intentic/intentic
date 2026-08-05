import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

// Bumped on any table/column change OR extraction-logic change that must reindex — mismatch drops and recreates
// everything (the index is a pure cache).
const SCHEMA_VERSION = "5";

const DDL = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS files (
    id INTEGER PRIMARY KEY,
    path TEXT NOT NULL UNIQUE,
    repo TEXT,
    lang TEXT,
    mtime_ms INTEGER NOT NULL,
    size INTEGER NOT NULL,
    hash TEXT NOT NULL,
    -- Branch-point count from indexer/complexity.ts — the structural half of the hotspots verb.
    complexity INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS symbols (
    id INTEGER PRIMARY KEY,
    file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    line INTEGER NOT NULL,
    end_line INTEGER NOT NULL,
    signature TEXT NOT NULL,
    exported INTEGER NOT NULL DEFAULT 0,
    heuristic INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS symbols_name ON symbols(name);
CREATE INDEX IF NOT EXISTS symbols_file ON symbols(file_id);
-- Module specifiers as written in the source, unresolved: resolution needs the whole file set, which only a
-- query has. These are the edges of the map verb's reference graph.
CREATE TABLE IF NOT EXISTS imports (
    id INTEGER PRIMARY KEY,
    file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    specifier TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS imports_file ON imports(file_id);
CREATE TABLE IF NOT EXISTS chunks (
    id INTEGER PRIMARY KEY,
    file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    start_line INTEGER NOT NULL,
    end_line INTEGER NOT NULL,
    hash TEXT NOT NULL,
    text TEXT NOT NULL,
    embedding BLOB
);
CREATE INDEX IF NOT EXISTS chunks_file ON chunks(file_id);
CREATE INDEX IF NOT EXISTS chunks_hash ON chunks(hash);
-- BM25 over chunk text (the sparse tier of hybrid retrieval). External-content: rows live in chunks; the
-- triggers keep the FTS index in sync — verified to fire on FK-cascade deletes too. tokenchars keeps
-- snake_case/$identifiers whole.
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(text, content='chunks', content_rowid='id', tokenize="unicode61 tokenchars '_$'");
CREATE TRIGGER IF NOT EXISTS chunks_fts_ai AFTER INSERT ON chunks BEGIN
    INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS chunks_fts_ad AFTER DELETE ON chunks BEGIN
    INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
`;

export type Row = Record<string, string | number | bigint | Uint8Array | null>;

// The narrow driver seam: everything above speaks these five methods, so swapping node:sqlite (experimental)
// for better-sqlite3 touches only this file.
export interface IndexDb {
    all(sql: string, ...params: (string | number | bigint | Uint8Array | null)[]): Row[];
    get(sql: string, ...params: (string | number | bigint | Uint8Array | null)[]): Row | undefined;
    run(sql: string, ...params: (string | number | bigint | Uint8Array | null)[]): void;
    transaction(fn: () => void): void;
    close(): void;
}

// How this handle intends to use the index. "read" is a genuinely read-only SQLite connection — not a promise
// to behave — so a caller that is not the index's writer (see indexer-lock.ts) cannot contend for the write
// lock even by accident, and a stray write is a loud error here rather than a lost race in production.
export type IndexMode = "write" | "read";

const wrap = (db: DatabaseSync): IndexDb => ({
    all: (sql, ...params) => db.prepare(sql).all(...params) as Row[],
    get: (sql, ...params) => db.prepare(sql).get(...params) as Row | undefined,
    run: (sql, ...params) => {
        db.prepare(sql).run(...params);
    },
    transaction: (fn) => {
        db.exec("BEGIN");
        try {
            fn();
            db.exec("COMMIT");
        } catch (error) {
            db.exec("ROLLBACK");
            throw error;
        }
    },
    close: () => db.close(),
});

const open = (dir: string, mode: IndexMode): IndexDb => {
    if (mode === "read") {
        const readOnly = new DatabaseSync(join(dir, "index.db"), { readOnly: true });
        // The reader still needs a timeout: WAL keeps it out of the writer's way, but a checkpoint takes the
        // file itself for a moment and a reader that arrives inside that moment must wait, not fail.
        readOnly.exec("PRAGMA busy_timeout = 5000;");
        // No DDL and no schema check: creating the schema is the writer's job, and a reader that reached this
        // point was told by the lock that a live writer owns the file — which means the schema is that writer's.
        return wrap(readOnly);
    }
    mkdirSync(join(dir, "spool"), { recursive: true });
    const db = new DatabaseSync(join(dir, "index.db"));
    // busy_timeout FIRST, alone: everything after it wants the write lock (journal_mode rewrites the header, the
    // DDL takes a schema lock), and until the timeout is set the default is zero — so an index another process
    // is mid-write on failed the OPEN instantly, before any of the contention handling below could apply.
    db.exec("PRAGMA busy_timeout = 5000;");
    db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;");
    db.exec(DDL);
    const wrapped = wrap(db);
    const version = wrapped.get("SELECT value FROM meta WHERE key = 'schema_version'")?.["value"];
    if (version === undefined) {
        wrapped.run("INSERT INTO meta (key, value) VALUES ('schema_version', ?)", SCHEMA_VERSION);
        return wrapped;
    }
    if (version !== SCHEMA_VERSION) {
        db.close();
        throw new Error(`iq index schema ${String(version)} != ${SCHEMA_VERSION}`);
    }
    return wrapped;
};

// Whether a failure is another writer holding the lock rather than a broken index. The distinction decides
// whether an opener may DELETE the index dir, so it lives here, next to the open that raises it.
export const isIndexBusy = (error: unknown): boolean =>
    error instanceof Error && /database is locked|database is busy|SQLITE_BUSY/i.test(error.message);

// Open the index at `<dir>/index.db`, treating corruption or schema drift as cache loss: delete the whole index
// dir and start fresh. A held write lock is contention from a concurrent opener (another iq process mid-write),
// NOT corruption — dropping the dir there would nuke an index that process is building, so it propagates. A
// "read" open never recreates anything: the writer owns that, and rebuilding under it is precisely the collision
// the mode exists to avoid.
export const openIndex = (dir: string, mode: IndexMode): IndexDb => {
    try {
        return open(dir, mode);
    } catch (error) {
        if (mode === "read" || isIndexBusy(error)) {
            throw error;
        }
        rmSync(dir, { recursive: true, force: true });
        return open(dir, mode);
    }
};
