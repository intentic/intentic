// node:sqlite is experimental, so a cache store holds the `SqliteDb` seam; openSqlite and immediateTransaction serve one holding it raw.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type SqliteValue = string | number | bigint | Uint8Array | null;
export type Row = Record<string, SqliteValue>;

export interface SqliteDb {
    all(sql: string, ...params: SqliteValue[]): Row[];
    get(sql: string, ...params: SqliteValue[]): Row | undefined;
    run(sql: string, ...params: SqliteValue[]): void;
    transaction(fn: () => void): void;
    close(): void;
}

/**
 * The seam over a driver handle. `transaction` is an explicit BEGIN/COMMIT/ROLLBACK because node:sqlite has no
 * helper of its own, and a throw inside it must roll back rather than leave the connection inside a transaction.
 */
export const wrapDb = (db: DatabaseSync): SqliteDb => ({
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
            // SQLite ends the transaction itself on a full disk or an I/O error; a ROLLBACK then would replace that error.
            if (db.isTransaction) {
                db.exec("ROLLBACK");
            }
            throw error;
        }
    },
    close: () => db.close(),
});

/**
 * Stamps the version into a fresh database's `meta` table, and refuses one written by a different version.
 * Never a migration: these stores are caches, so the caller answers a mismatch by deleting and reopening.
 */
export const guardSchemaVersion = (db: SqliteDb, version: string, label: string): void => {
    const found = db.get("SELECT value FROM meta WHERE key = 'schema_version'")?.["value"];
    if (found === undefined) {
        db.run("INSERT INTO meta (key, value) VALUES ('schema_version', ?)", version);
        return;
    }
    if (found !== version) {
        db.close();
        throw new Error(`${label} schema ${String(found)} != ${version}`);
    }
};

// A database that lives and dies with its handle: the same schema and SQL, for a test that must not touch disk.
export const IN_MEMORY = ":memory:";

// How long a statement waits on another connection's write lock: one transaction's milliseconds, so a hang bound, not a latency.
const BUSY_TIMEOUT_MS = 5_000;

// WAL, so a reader never waits on a writer; NORMAL, since under WAL a crash loses no committed transaction, only power loss can.
export const openSqlite = (path: string, options: { readonly readOnly?: boolean } = {}): DatabaseSync => {
    const memory = path === IN_MEMORY;
    if (!memory && options.readOnly !== true) {
        mkdirSync(dirname(path), { recursive: true });
    }
    const db = new DatabaseSync(path, { readOnly: options.readOnly === true });
    // Foreign keys are per connection and off unless asked; the timeout is set before anything below needs a lock.
    db.exec(`PRAGMA foreign_keys = ON; PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`);
    if (!memory && options.readOnly !== true) {
        db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
    }
    return db;
};

// All of `work` or none of it, unlike the seam's plain BEGIN: an open transaction is joined, so the outermost caller's covers it.
export const immediateTransaction = <T>(db: DatabaseSync, work: () => T): T => {
    if (db.isTransaction) {
        return work();
    }
    // IMMEDIATE takes the write lock up front, so a second writer waits at BEGIN instead of failing at its first write.
    db.exec("BEGIN IMMEDIATE");
    try {
        const result = work();
        // An await inside would let unrelated statements run inside this transaction, and commit them with it.
        if (result instanceof Promise) {
            throw new TypeError("a transaction's work must be synchronous");
        }
        db.exec("COMMIT");
        return result;
    } catch (error) {
        // SQLite has already rolled back after some failures (a full disk, an I/O error); a second ROLLBACK would bury why.
        if (db.isTransaction) {
            db.exec("ROLLBACK");
        }
        throw error;
    }
};
