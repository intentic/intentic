import { mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

// Bumped on any table/column change OR extraction-logic change that must re-ingest — mismatch drops and
// recreates everything (the recall index is a pure cache over ~/.claude/projects transcripts).
const SCHEMA_VERSION = "2";

const DDL = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS transcripts (
    id INTEGER PRIMARY KEY,
    path TEXT NOT NULL UNIQUE,
    session_id TEXT NOT NULL,
    byte_offset INTEGER NOT NULL,
    mtime_ms INTEGER NOT NULL,
    size INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY,
    session_id TEXT NOT NULL UNIQUE,
    slug TEXT,
    title TEXT,
    version TEXT,
    git_branch TEXT,
    first_ts INTEGER NOT NULL,
    last_ts INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS turns (
    id INTEGER PRIMARY KEY,
    session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    uuid TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    ts INTEGER NOT NULL,
    prompt TEXT NOT NULL,
    -- The turn's closing assistant text message (head-capped at ingest) — the answer, for excerpt recall.
    response TEXT NOT NULL DEFAULT '',
    start_byte INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS turns_session ON turns(session_id);
CREATE TABLE IF NOT EXISTS turn_files (
    turn_id INTEGER NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    modified INTEGER NOT NULL DEFAULT 0,
    last_ts INTEGER NOT NULL,
    PRIMARY KEY (turn_id, path)
);
CREATE INDEX IF NOT EXISTS turn_files_path ON turn_files(path);
-- BM25 over typed prompts, closing assistant responses, and session titles. External-content: rows live in
-- turns/sessions; the triggers keep the FTS index in sync (they fire on FK-cascade deletes too, and on the
-- response overwrite an incremental ingest applies to a still-open turn). tokenchars keeps
-- snake_case/$identifiers whole — same setup as iq-engine's chunks_fts.
CREATE VIRTUAL TABLE IF NOT EXISTS turns_fts USING fts5(prompt, response, content='turns', content_rowid='id', tokenize="unicode61 tokenchars '_$'");
CREATE TRIGGER IF NOT EXISTS turns_fts_ai AFTER INSERT ON turns BEGIN
    INSERT INTO turns_fts(rowid, prompt, response) VALUES (new.id, new.prompt, new.response);
END;
CREATE TRIGGER IF NOT EXISTS turns_fts_ad AFTER DELETE ON turns BEGIN
    INSERT INTO turns_fts(turns_fts, rowid, prompt, response) VALUES ('delete', old.id, old.prompt, old.response);
END;
CREATE TRIGGER IF NOT EXISTS turns_fts_au AFTER UPDATE OF response ON turns BEGIN
    INSERT INTO turns_fts(turns_fts, rowid, prompt, response) VALUES ('delete', old.id, old.prompt, old.response);
    INSERT INTO turns_fts(rowid, prompt, response) VALUES (new.id, new.prompt, new.response);
END;
CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts USING fts5(title, content='sessions', content_rowid='id', tokenize="unicode61 tokenchars '_$'");
CREATE TRIGGER IF NOT EXISTS sessions_fts_ai AFTER INSERT ON sessions BEGIN
    INSERT INTO sessions_fts(rowid, title) VALUES (new.id, coalesce(new.title, ''));
END;
CREATE TRIGGER IF NOT EXISTS sessions_fts_ad AFTER DELETE ON sessions BEGIN
    INSERT INTO sessions_fts(sessions_fts, rowid, title) VALUES ('delete', old.id, coalesce(old.title, ''));
END;
CREATE TRIGGER IF NOT EXISTS sessions_fts_au AFTER UPDATE OF title ON sessions BEGIN
    INSERT INTO sessions_fts(sessions_fts, rowid, title) VALUES ('delete', old.id, coalesce(old.title, ''));
    INSERT INTO sessions_fts(rowid, title) VALUES (new.id, coalesce(new.title, ''));
END;
`;

export type Row = Record<string, string | number | bigint | Uint8Array | null>;

// The narrow driver seam, mirroring iq-engine's IndexDb (not exported there): swapping node:sqlite
// (experimental) for another driver touches only this file.
export interface RecallDb {
    all(sql: string, ...params: (string | number | bigint | Uint8Array | null)[]): Row[];
    get(sql: string, ...params: (string | number | bigint | Uint8Array | null)[]): Row | undefined;
    run(sql: string, ...params: (string | number | bigint | Uint8Array | null)[]): void;
    transaction(fn: () => void): void;
    close(): void;
}

const open = (dbPath: string): RecallDb => {
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
    db.exec(DDL);
    const wrapped: RecallDb = {
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
    };
    const version = wrapped.get("SELECT value FROM meta WHERE key = 'schema_version'")?.["value"];
    if (version === undefined) {
        wrapped.run("INSERT INTO meta (key, value) VALUES ('schema_version', ?)", SCHEMA_VERSION);
        return wrapped;
    }
    if (version !== SCHEMA_VERSION) {
        db.close();
        throw new Error(`iq recall schema ${String(version)} != ${SCHEMA_VERSION}`);
    }
    return wrapped;
};

// Open the recall db, treating any failure (corruption, schema drift) as cache loss. Only the db's own files
// are removed — it shares .intentic/iq with index.db, whose openIndex wipes the whole dir on ITS failures;
// recall re-ingests from transcripts either way.
export const openRecallDb = (dbPath: string): RecallDb => {
    try {
        return open(dbPath);
    } catch {
        for (const suffix of ["", "-wal", "-shm"]) {
            rmSync(dbPath + suffix, { force: true });
        }
        return open(dbPath);
    }
};
