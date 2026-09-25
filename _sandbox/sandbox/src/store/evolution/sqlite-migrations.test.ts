import { IN_MEMORY, openSqlite } from "@intentic/base/sqlite";
import { migrateSqlite, schemaVersionOf, type SqliteStep } from "./sqlite-migrations.js";

const BASELINE = "CREATE TABLE IF NOT EXISTS note (id TEXT PRIMARY KEY, body TEXT NOT NULL) STRICT;";
const columnsOf = (db: ReturnType<typeof openSqlite>): string[] =>
    (db.prepare("SELECT name FROM pragma_table_info('note')").all() as { name: string }[]).map(({ name }) => name);

test("a fresh database takes the baseline as version 1, and a second open changes nothing", () => {
    const db = openSqlite(IN_MEMORY);
    expect(migrateSqlite(db, BASELINE, [])).toEqual({ from: 0, to: 1, newer: false });
    expect(schemaVersionOf(db)).toBe(1);
    expect(migrateSqlite(db, BASELINE, [])).toEqual({ from: 1, to: 1, newer: false });
});

test("a database from before any stamp keeps its rows and is stamped the baseline", () => {
    const db = openSqlite(IN_MEMORY);
    db.exec(BASELINE);
    db.prepare("INSERT INTO note VALUES (?, ?)").run("a", "kept");
    migrateSqlite(db, BASELINE, []);
    expect(db.prepare("SELECT * FROM note").all()).toEqual([{ id: "a", body: "kept" }]);
    expect(schemaVersionOf(db)).toBe(1);
});

test("steps run in order, each stamping its own version", () => {
    const db = openSqlite(IN_MEMORY);
    const steps: SqliteStep[] = [
        { describe: "adds note.pinned", up: (target) => target.exec("ALTER TABLE note ADD COLUMN pinned INTEGER") },
        { describe: "adds note.tag", up: (target) => target.exec("ALTER TABLE note ADD COLUMN tag TEXT") },
    ];
    expect(migrateSqlite(db, BASELINE, steps)).toEqual({ from: 0, to: 3, newer: false });
    expect(columnsOf(db)).toEqual(["id", "body", "pinned", "tag"]);
    expect(schemaVersionOf(db)).toBe(3);
});

test("a step that throws rolls back with its stamp, so the next open retries it", () => {
    const db = openSqlite(IN_MEMORY);
    migrateSqlite(db, BASELINE, []);
    const failing: SqliteStep = {
        describe: "adds a column, then fails",
        up: (target) => {
            target.exec("ALTER TABLE note ADD COLUMN half INTEGER");
            throw new Error("disk full");
        },
    };
    expect(() => migrateSqlite(db, BASELINE, [failing])).toThrow("disk full");
    expect(schemaVersionOf(db)).toBe(1);
    expect(columnsOf(db)).toEqual(["id", "body"]);
});

test("a newer build's database is left exactly as it is", () => {
    const db = openSqlite(IN_MEMORY);
    migrateSqlite(db, BASELINE, []);
    db.exec("PRAGMA user_version = 9");
    expect(migrateSqlite(db, BASELINE, [])).toEqual({ from: 9, to: 1, newer: true });
    expect(schemaVersionOf(db)).toBe(9);
});
