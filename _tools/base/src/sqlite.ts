// A node:sqlite database opened the way every store here opens one, and its writes grouped under one lock.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

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

// All of `work` or none of it: an open transaction is joined, so the outermost caller's covers it.
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
