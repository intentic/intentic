import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, expect, afterEach } from "bun:test";
import { guardSchemaVersion, wrapDb } from "./sqlite.js";

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
