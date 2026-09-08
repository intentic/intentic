import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

// Vectors outlive the index: a pure function of (model, chunk text), unlike the index itself. Dropped index dirs
// rebuild from this sidecar, keyed by the same sha256-of-chunk-text the chunks table carries, so only new text reaches
// the model. Same recovery rule as the index: corruption or a schema bump deletes the file and starts empty.

const CACHE_SCHEMA = "1";

// LRU ceiling; at ~1.6 kB/row this bounds the file near 300 MB, enough that daily churn evicts nothing warm.
const MAX_ROWS = 200_000;

const DDL = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS vectors (
    hash TEXT PRIMARY KEY,
    embedding BLOB NOT NULL,
    used_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS vectors_used ON vectors(used_at);
`;

export interface VectorCache {
    /** Cached vectors for these chunk hashes (misses simply absent). Hits are touched for LRU. */
    get(hashes: readonly string[]): Map<string, Uint8Array>;
    /** Store freshly computed vectors. Content-keyed, so concurrent writers can only agree. */
    put(entries: ReadonlyMap<string, Uint8Array>): void;
    /** Trim past the LRU ceiling and reclaim the pages. Called after a backlog drain, not per batch. */
    compact(): void;
    close(): void;
}

/** The cache file for the index at `indexDir`, a sibling path, so dropping the index dir never touches it. */
export const vectorCachePath = (indexDir: string): string => `${indexDir}-vectors.db`;

const open = (path: string, modelId: string, maxRows: number): VectorCache => {
    mkdirSync(dirname(path), { recursive: true });
    const db = new DatabaseSync(path);
    // Same open order as the index: busy_timeout, then auto_vacuum only while still empty, then WAL.
    db.exec("PRAGMA busy_timeout = 5000;");
    const pageCount = Number((db.prepare("PRAGMA page_count").get() as { page_count?: number | bigint } | undefined)?.page_count ?? 0);
    if (pageCount === 0) {
        db.exec("PRAGMA auto_vacuum = INCREMENTAL;");
    }
    db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
    db.exec(DDL);
    const meta = (key: string): string | undefined =>
        (db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value?: string } | undefined)?.value;
    const setMeta = (key: string, value: string): void => {
        db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
    };
    const version = meta("cache_version");
    if (version !== undefined && version !== CACHE_SCHEMA) {
        db.close();
        throw new Error(`iq vector cache schema ${version} != ${CACHE_SCHEMA}`);
    }
    setMeta("cache_version", CACHE_SCHEMA);
    // A model swap makes every stored vector wrong, not stale; same rule syncModel applies to the index.
    if (meta("model_id") !== modelId) {
        db.exec("DELETE FROM vectors");
        setMeta("model_id", modelId);
    }
    return {
        get(hashes) {
            const found = new Map<string, Uint8Array>();
            if (hashes.length === 0) {
                return found;
            }
            const distinct = [...new Set(hashes)];
            const marks = distinct.map(() => "?").join(", ");
            for (const row of db.prepare(`SELECT hash, embedding FROM vectors WHERE hash IN (${marks})`).all(...distinct) as {
                hash: string;
                embedding: Uint8Array;
            }[]) {
                found.set(row.hash, row.embedding);
            }
            if (found.size > 0) {
                const hitMarks = [...found.keys()].map(() => "?").join(", ");
                db.prepare(`UPDATE vectors SET used_at = ? WHERE hash IN (${hitMarks})`).run(Date.now(), ...found.keys());
            }
            return found;
        },
        put(entries) {
            if (entries.size === 0) {
                return;
            }
            const insert = db.prepare(
                "INSERT INTO vectors (hash, embedding, used_at) VALUES (?, ?, ?) ON CONFLICT(hash) DO UPDATE SET embedding = excluded.embedding, used_at = excluded.used_at",
            );
            db.exec("BEGIN");
            try {
                for (const [hash, embedding] of entries) {
                    insert.run(hash, embedding, Date.now());
                }
                db.exec("COMMIT");
            } catch (error) {
                db.exec("ROLLBACK");
                throw error;
            }
        },
        compact() {
            const rows = Number((db.prepare("SELECT COUNT(*) AS n FROM vectors").get() as { n: number | bigint }).n);
            if (rows <= maxRows) {
                return;
            }
            db.prepare("DELETE FROM vectors WHERE hash IN (SELECT hash FROM vectors ORDER BY used_at ASC LIMIT ?)").run(rows - maxRows);
            db.exec("PRAGMA incremental_vacuum");
        },
        close: () => db.close(),
    };
};

// Treats any open failure as cache loss: deletes the file and retries once. Failing twice returns undefined; the
// semantic tier still works, just re-embedding everything.
export const openVectorCache = (path: string, modelId: string, maxRows = MAX_ROWS): VectorCache | undefined => {
    try {
        return open(path, modelId, maxRows);
    } catch {
        for (const suffix of ["", "-wal", "-shm"]) {
            if (existsSync(`${path}${suffix}`)) {
                rmSync(`${path}${suffix}`, { force: true });
            }
        }
        try {
            return open(path, modelId, maxRows);
        } catch {
            return undefined;
        }
    }
};
