import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { guardSchemaVersion, IN_MEMORY, immediateTransaction, openSqlite, wrapDb } from "./sqlite.js";

const dirs: string[] = [];
const openTemp = (): DatabaseSync => {
    const dir = mkdtempSync(join(tmpdir(), "base-sqlite-"));
    dirs.push(dir);
    const db = new DatabaseSync(join(dir, "test.db"));
    db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE t (n INTEGER);");
    return db;
};

afterEach(() => {
    for (const dir of dirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("a throw inside a transaction rolls back, leaving no half-written rows", () => {
    const db = wrapDb(openTemp());
    db.run("INSERT INTO t (n) VALUES (?)", 1);
    expect(() =>
        db.transaction(() => {
            db.run("INSERT INTO t (n) VALUES (?)", 2);
            throw new Error("nope");
        }),
    ).toThrow("nope");
    expect(db.all("SELECT n FROM t")).toEqual([{ n: 1 }]);
    // The connection is usable afterwards: a failed rollback would leave it inside the transaction.
    db.transaction(() => db.run("INSERT INTO t (n) VALUES (?)", 3));
    expect(db.all("SELECT n FROM t")).toEqual([{ n: 1 }, { n: 3 }]);
    db.close();
});

test("a transaction SQLite already ended throws its own error, not the rollback's", () => {
    const db = wrapDb(openTemp());
    db.run("CREATE TABLE u (n INTEGER PRIMARY KEY)");
    expect(() =>
        db.transaction(() => {
            db.run("INSERT INTO u (n) VALUES (?)", 1);
            db.run("INSERT OR ROLLBACK INTO u (n) VALUES (?)", 1);
        }),
    ).toThrow("UNIQUE constraint failed: u.n");
    expect(db.all("SELECT n FROM u")).toEqual([]);
    db.close();
});

test("a fresh database is stamped; the same version reopens; a different one is refused", () => {
    const db = wrapDb(openTemp());
    guardSchemaVersion(db, "2", "iq recall");
    expect(db.get("SELECT value FROM meta WHERE key = 'schema_version'")).toEqual({ value: "2" });
    guardSchemaVersion(db, "2", "iq recall");
    expect(() => guardSchemaVersion(db, "3", "iq recall")).toThrow("iq recall schema 2 != 3");
});

test("get answers undefined for no row, and all answers an empty list", () => {
    const db = wrapDb(openTemp());
    expect(db.get("SELECT n FROM t WHERE n = ?", 9)).toBeUndefined();
    expect(db.all("SELECT n FROM t")).toEqual([]);
    db.close();
});

const tempDir = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "base-sqlite-"));
    dirs.push(dir);
    return dir;
};

// A pragma's one column, whatever SQLite names it (`busy_timeout` answers as `timeout`).
const pragma = (db: DatabaseSync, name: string): unknown => Object.values(db.prepare(`PRAGMA ${name}`).get() ?? {})[0];

test("openSqlite opens a file database in WAL with foreign keys and a busy timeout, creating its directory", () => {
    const path = join(tempDir(), "nested", "state.db");
    const db = openSqlite(path);
    const settings = ["journal_mode", "synchronous", "foreign_keys", "busy_timeout"].map((name) => pragma(db, name));
    expect(settings).toEqual(["wal", 1, 1, 5000]);
    db.close();
});

test("openSqlite keeps an in-memory database out of WAL, and a read-only open creates nothing", () => {
    const memory = openSqlite(IN_MEMORY);
    expect([pragma(memory, "journal_mode"), pragma(memory, "foreign_keys")]).toEqual(["memory", 1]);
    memory.close();
    const missing = join(tempDir(), "absent", "state.db");
    expect(() => openSqlite(missing, { readOnly: true })).toThrow();
    expect(existsSync(join(missing, ".."))).toBe(false);
});

test("immediateTransaction commits its work together, and a throw rolls every statement back", () => {
    const db = openTemp();
    expect(immediateTransaction(db, () => db.prepare("INSERT INTO t (n) VALUES (?)").run(1).changes)).toBe(1);
    expect(() =>
        immediateTransaction(db, () => {
            db.prepare("INSERT INTO t (n) VALUES (?)").run(2);
            throw new Error("nope");
        }),
    ).toThrow("nope");
    expect(db.prepare("SELECT n FROM t").all()).toEqual([{ n: 1 }]);
    expect(db.isTransaction).toBe(false);
    db.close();
});

test("an immediateTransaction inside another joins it, so the outer rollback takes the inner work too", () => {
    const db = openTemp();
    expect(() =>
        immediateTransaction(db, () => {
            immediateTransaction(db, () => db.prepare("INSERT INTO t (n) VALUES (?)").run(1));
            throw new Error("outer failed");
        }),
    ).toThrow("outer failed");
    expect(db.prepare("SELECT n FROM t").all()).toEqual([]);
    db.close();
});

test("immediateTransaction refuses asynchronous work and rolls back what it began", () => {
    const db = openTemp();
    expect(() => immediateTransaction(db, async () => undefined)).toThrow("a transaction's work must be synchronous");
    expect(db.isTransaction).toBe(false);
    db.close();
});

test("immediateTransaction holds the write lock from BEGIN, before its first write", () => {
    const path = join(tempDir(), "locked.db");
    const db = openSqlite(path);
    db.exec("CREATE TABLE t (n INTEGER)");
    const other = new DatabaseSync(path);
    other.exec("PRAGMA busy_timeout = 0");
    immediateTransaction(db, () => {
        expect(() => other.exec("BEGIN IMMEDIATE")).toThrow("database is locked");
    });
    other.exec("BEGIN IMMEDIATE");
    other.exec("ROLLBACK");
    other.close();
    db.close();
});
