import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { IN_MEMORY, immediateTransaction, openSqlite } from "./sqlite.js";

const dirs: string[] = [];
const openTemp = (): DatabaseSync => {
    const dir = mkdtempSync(join(tmpdir(), "base-sqlite-"));
    dirs.push(dir);
    const db = new DatabaseSync(join(dir, "test.db"));
    db.exec("CREATE TABLE t (n INTEGER);");
    return db;
};

afterEach(() => {
    for (const dir of dirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
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
