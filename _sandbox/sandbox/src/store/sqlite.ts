import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

// The daemon's SQLite plumbing, shared by every database it keeps on the history volume: how one is opened, and the
// one way a group of statements commits together or not at all.

// A database that lives and dies with its handle: the same schema and SQL, for a test that must not touch disk.
export const IN_MEMORY = ":memory:";

// How long a statement waits on another process's write lock (a second daemon on the same volume, a diagnostics read)
// before failing; a lock is held for one transaction, milliseconds, so this is a hang bound, not a latency.
const BUSY_TIMEOUT_MS = 5_000;

// WAL, so a reader never waits on a writer; NORMAL, since under WAL a crashed process loses no committed transaction and
// only power loss can roll back the last few. Foreign keys are per connection in SQLite, and off unless asked.
export const openSqlite = (path: string, options: { readonly readOnly?: boolean } = {}): DatabaseSync => {
    const memory = path === IN_MEMORY;
    if (!memory && options.readOnly !== true) {
        mkdirSync(dirname(path), { recursive: true });
    }
    const db = new DatabaseSync(path, { readOnly: options.readOnly === true });
    db.exec(`PRAGMA foreign_keys = ON; PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`);
    if (!memory && options.readOnly !== true) {
        db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
    }
    return db;
};

/* ALL OF `work`, OR NONE OF IT: its statements commit together, and any throw rolls every one of them back. An open
   transaction is joined rather than nested, so the outermost caller's all-or-nothing covers the inner work too. */
export const transaction = <T>(db: DatabaseSync, work: () => T): T => {
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
        // SQLite has already rolled back after some failures (a full disk, an I/O error), and a second ROLLBACK would
        // throw over the error that says why.
        if (db.isTransaction) {
            db.exec("ROLLBACK");
        }
        throw error;
    }
};
