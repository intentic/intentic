import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSqlite } from "@intentic/base/sqlite";
import { headerSchemaVersion, migrateSqlite } from "./sqlite-migrations.js";

test("the header stamp reads without opening the database, and a missing or truncated file reads as nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sqlite-header-"));
    const path = join(dir, "stamped.db");
    const db = openSqlite(path);
    migrateSqlite(db, "CREATE TABLE IF NOT EXISTS t (x INTEGER) STRICT;", [{ describe: "adds t.y", up: (target) => target.exec("ALTER TABLE t ADD COLUMN y INTEGER") }]);
    // A checkpoint moves the stamp from the write-ahead log into the file's header, as a clean shutdown does.
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    db.close();
    expect(await headerSchemaVersion(path)).toBe(2);
    expect(await headerSchemaVersion(join(dir, "absent.db"))).toBeUndefined();
    writeFileSync(join(dir, "short.db"), "SQLite format 3");
    expect(await headerSchemaVersion(join(dir, "short.db"))).toBeUndefined();
});
