import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getLoadablePath } from "sqlite-vec";

// Bump on any schema or extraction-logic change that must reindex; a mismatch drops and rebuilds the whole index.
const SCHEMA_VERSION = "7";

// Embeddings are stored as one signed byte per dimension; cosine is unaffected since vectors are normalized before
// quantizing.
const EMBEDDING_DIM = 384;

// Reclaim runs only once the freelist exceeds this fraction of total pages.
const COMPACT_FREELIST_RATIO = 0.25;

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
    -- Branch-point count from indexer/complexity.ts: the structural half of the hotspots verb.
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
    -- Whether chunk_vectors holds a row for this chunk. Denormalized because the two questions asked of it are
    -- asked constantly and neither is cheap against the vector table: "which chunks still need embedding" runs
    -- every top-up batch, and "how many are left" runs on every natural-language query, for the "embeddings
    -- 87%" note. Counting the vector table instead measured 7.5ms; the partial index below answers both in
    -- microseconds and shrinks to nothing as coverage completes. Written in the same statement pair as the
    -- vector row, so the two cannot disagree.
    embedded INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS chunks_file ON chunks(file_id);
CREATE INDEX IF NOT EXISTS chunks_hash ON chunks(hash);
CREATE INDEX IF NOT EXISTS chunks_unembedded ON chunks(id) WHERE embedded = 0;
-- BM25 over chunk text (the sparse tier of hybrid retrieval). External-content: rows live in chunks; the
-- triggers keep the FTS index in sync: verified to fire on FK-cascade deletes too. tokenchars keeps
-- snake_case/$identifiers whole.
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(text, content='chunks', content_rowid='id', tokenize="unicode61 tokenchars '_$'");
CREATE TRIGGER IF NOT EXISTS chunks_fts_ai AFTER INSERT ON chunks BEGIN
    INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS chunks_fts_ad AFTER DELETE ON chunks BEGIN
    INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
-- The dense tier, and the counterpart to chunks_fts above: sqlite-vec ranks the whole corpus inside SQLite and
-- returns only the k rows asked for, where this used to hand every vector to JavaScript and score them there.
-- file_id is a metadata column rather than an auxiliary (+) one specifically so a scoped query can filter on it
-- DURING the ranking pass: filtering afterwards would return the top k of the workspace and then discard the
-- ones out of scope, which is a different (and wrong) answer.
CREATE VIRTUAL TABLE IF NOT EXISTS chunk_vectors USING vec0(
    chunk_id INTEGER PRIMARY KEY,
    embedding int8[${EMBEDDING_DIM}] distance_metric=cosine,
    file_id INTEGER
);
-- vec0 is not a real table, so it is outside foreign keys: nothing cascades into it. This trigger is what
-- deletes a vector when its chunk goes, including on the FK cascade from files that chunks_fts_ad also relies on.
CREATE TRIGGER IF NOT EXISTS chunks_vec_ad AFTER DELETE ON chunks BEGIN
    DELETE FROM chunk_vectors WHERE chunk_id = old.id;
END;
`;

export type Row = Record<string, string | number | bigint | Uint8Array | null>;

// Driver seam: callers use only these five methods, so swapping node:sqlite for another driver touches only this file.
export interface IndexDb {
    all(sql: string, ...params: (string | number | bigint | Uint8Array | null)[]): Row[];
    get(sql: string, ...params: (string | number | bigint | Uint8Array | null)[]): Row | undefined;
    run(sql: string, ...params: (string | number | bigint | Uint8Array | null)[]): void;
    transaction(fn: () => void): void;
    close(): void;
}

const pragmaNumber = (db: IndexDb, name: "freelist_count" | "page_count"): number => Number(db.get(`PRAGMA ${name}`)?.[name] ?? 0);

/** Reclaims freelist pages once fragmentation exceeds the threshold; returns whether a vacuum ran. */
export const compactIndex = (db: IndexDb): boolean => {
    const pageCount = pragmaNumber(db, "page_count");
    const freePages = pragmaNumber(db, "freelist_count");
    if (pageCount === 0 || freePages / pageCount < COMPACT_FREELIST_RATIO) {
        return false;
    }
    db.run("PRAGMA incremental_vacuum");
    return true;
};

// "read" is a genuinely read-only connection; a non-writer caller cannot contend for the write lock, so a stray write
// errors immediately instead of racing.
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

// vec0 is a loadable extension: every handle, including readers, must load it before referencing chunk_vectors. Loading
// is disabled again right after so no other SQL can open a shared library.
const loadVectorExtension = (db: DatabaseSync): void => {
    db.enableLoadExtension(true);
    db.loadExtension(getLoadablePath());
    db.enableLoadExtension(false);
};

const open = (dir: string, mode: IndexMode): IndexDb => {
    if (mode === "read") {
        const readOnly = new DatabaseSync(join(dir, "index.db"), { readOnly: true, allowExtension: true });
        // A checkpoint briefly locks the file even under WAL; a reader arriving then must wait, not fail.
        readOnly.exec("PRAGMA busy_timeout = 5000;");
        loadVectorExtension(readOnly);
        // No DDL or schema check: the lock guarantees a live writer already owns and created the schema.
        return wrap(readOnly);
    }
    // Creates only the index directory; the open call below creates index.db itself.
    mkdirSync(dir, { recursive: true });
    const db = new DatabaseSync(join(dir, "index.db"), { allowExtension: true });
    // Must run before journal_mode or the DDL: both need the write lock, and the timeout defaults to zero until set.
    db.exec("PRAGMA busy_timeout = 5000;");
    // Set auto_vacuum only when the file is new; reasserting it later could contend with a mid-transaction writer.
    const pageCount = Number((db.prepare("PRAGMA page_count").get() as Row | undefined)?.["page_count"] ?? 0);
    if (pageCount === 0) {
        db.exec("PRAGMA auto_vacuum = INCREMENTAL;");
    }
    db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;");
    // Must precede the DDL: it creates a vec0 table, which needs this extension loaded first.
    loadVectorExtension(db);
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

// True when a failure means a concurrent writer holds the lock, not that the index is corrupt.
export const isIndexBusy = (error: unknown): boolean =>
    error instanceof Error && /database is locked|database is busy|SQLITE_BUSY/i.test(error.message);

// Opens the index at `<dir>/index.db`; treats corruption or schema drift as cache loss by deleting the dir and
// rebuilding. A held write lock from a concurrent writer propagates instead. A "read" open never recreates anything.
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
