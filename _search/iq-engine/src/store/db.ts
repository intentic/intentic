import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getLoadablePath } from "sqlite-vec";

// Bumped on any table/column change OR extraction-logic change that must reindex, mismatch drops and recreates
// everything (the index is a pure cache).
const SCHEMA_VERSION = "7";

// Vectors are stored quantized to one signed byte per dimension instead of a four-byte float. The model's
// output is normalized, so cosine, which divides the length back out, is unaffected by the scaling that
// quantizing needs, and the ranking it produces is the same ranking the float vectors produced: measured over
// this workspace's index and 30 natural-language queries, 97.4% of the top 24 and 100% of the top hit are
// identical, with scores differing by at most 0.005 (a displayed score is rounded to 0.01). What it buys is
// the four-fold shrink — 98 MB of vectors become 27 MB, and a search that no longer reads them all.
const EMBEDDING_DIM = 384;

// Reclaim only when fragmentation is material. Incremental auto-vacuum moves live pages and truncates the file,
// so running it after every small delete would turn ordinary indexing into needless page churn. The audited
// production index had 72% of its pages on the freelist; 25% keeps that failure mode bounded without polishing
// tiny databases after every pass.
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
-- triggers keep the FTS index in sync — verified to fire on FK-cascade deletes too. tokenchars keeps
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
-- DURING the ranking pass — filtering afterwards would return the top k of the workspace and then discard the
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

// The narrow driver seam: everything above speaks these five methods, so swapping node:sqlite (experimental)
// for better-sqlite3 touches only this file.
export interface IndexDb {
    all(sql: string, ...params: (string | number | bigint | Uint8Array | null)[]): Row[];
    get(sql: string, ...params: (string | number | bigint | Uint8Array | null)[]): Row | undefined;
    run(sql: string, ...params: (string | number | bigint | Uint8Array | null)[]): void;
    transaction(fn: () => void): void;
    close(): void;
}

const pragmaNumber = (db: IndexDb, name: "freelist_count" | "page_count"): number => Number(db.get(`PRAGMA ${name}`)?.[name] ?? 0);

/** Reclaim SQLite freelist pages after a completed writer pass when fragmentation exceeds the threshold. */
export const compactIndex = (db: IndexDb): boolean => {
    const pageCount = pragmaNumber(db, "page_count");
    const freePages = pragmaNumber(db, "freelist_count");
    if (pageCount === 0 || freePages / pageCount < COMPACT_FREELIST_RATIO) {
        return false;
    }
    db.run("PRAGMA incremental_vacuum");
    return true;
};

// How this handle intends to use the index. "read" is a genuinely read-only SQLite connection, not a promise
// to behave, so a caller that is not the index's writer (see indexer-lock.ts) cannot contend for the write
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

// vec0 is a loadable extension, so every handle has to load it before it can so much as name chunk_vectors,
// readers included, because the KNN query is theirs. The door is shut again immediately: the only extension
// this process ever wants is this one, and leaving loading enabled would let any later SQL string open a shared
// library. sqlite-vec ships prebuilt per platform and picks the right binary itself.
const loadVectorExtension = (db: DatabaseSync): void => {
    db.enableLoadExtension(true);
    db.loadExtension(getLoadablePath());
    db.enableLoadExtension(false);
};

const open = (dir: string, mode: IndexMode): IndexDb => {
    if (mode === "read") {
        const readOnly = new DatabaseSync(join(dir, "index.db"), { readOnly: true, allowExtension: true });
        // The reader still needs a timeout: WAL keeps it out of the writer's way, but a checkpoint takes the
        // file itself for a moment and a reader that arrives inside that moment must wait, not fail.
        readOnly.exec("PRAGMA busy_timeout = 5000;");
        loadVectorExtension(readOnly);
        // No DDL and no schema check: creating the schema is the writer's job, and a reader that reached this
        // point was told by the lock that a live writer owns the file, which means the schema is that writer's.
        return wrap(readOnly);
    }
    // The index dir itself, so the open below has somewhere to put index.db, and ONLY that. The spool used to be
    // created here too, which left every workspace holding an empty `spool/` from its first search until its
    // first continuation cursor, and holding one again after each prune; writeSpool creates it when it has
    // something to write, which is the only moment it means anything.
    mkdirSync(dir, { recursive: true });
    const db = new DatabaseSync(join(dir, "index.db"), { allowExtension: true });
    // busy_timeout FIRST, alone: everything after it wants the write lock (journal_mode rewrites the header, the
    // DDL takes a schema lock), and until the timeout is set the default is zero, so an index another process
    // is mid-write on failed the OPEN instantly, before any of the contention handling below could apply.
    db.exec("PRAGMA busy_timeout = 5000;");
    // Must be configured before the first table is created. Do not write this pragma on every open: diagnostic
    // handles may arrive while the indexer is mid-transaction, and reasserting an already-persisted header mode
    // would contend with that writer. Schema v7 forces older non-empty indexes through the normal cache rebuild.
    const pageCount = Number((db.prepare("PRAGMA page_count").get() as Row | undefined)?.["page_count"] ?? 0);
    if (pageCount === 0) {
        db.exec("PRAGMA auto_vacuum = INCREMENTAL;");
    }
    db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;");
    // Before the DDL, which creates a vec0 table and so needs the extension that defines it.
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

// Whether a failure is another writer holding the lock rather than a broken index. The distinction decides
// whether an opener may DELETE the index dir, so it lives here, next to the open that raises it.
export const isIndexBusy = (error: unknown): boolean =>
    error instanceof Error && /database is locked|database is busy|SQLITE_BUSY/i.test(error.message);

// Open the index at `<dir>/index.db`, treating corruption or schema drift as cache loss: delete the whole index
// dir and start fresh. A held write lock is contention from a concurrent opener (another iq process mid-write),
// NOT corruption, dropping the dir there would nuke an index that process is building, so it propagates. A
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
