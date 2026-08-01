import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { openRecallDb } from "./db.js";

let dir: string;

beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "iq-recall-db-"));
});
afterAll(() => rm(dir, { recursive: true, force: true }));

test("schema drift drops and recreates the db (pure cache)", () => {
    const path = join(dir, "drift.db");
    const db = openRecallDb(path);
    db.run("INSERT INTO sessions (session_id, first_ts, last_ts) VALUES ('s1', 1, 2)");
    db.run("UPDATE meta SET value = '0-obsolete' WHERE key = 'schema_version'");
    db.close();
    const reopened = openRecallDb(path);
    expect(reopened.get("SELECT COUNT(*) AS n FROM sessions")?.["n"]).toBe(0);
    reopened.close();
});

test("cascade deletes keep the FTS indexes in sync", () => {
    const db = openRecallDb(join(dir, "cascade.db"));
    db.run("INSERT INTO sessions (session_id, title, first_ts, last_ts) VALUES ('s1', 'auth session', 1, 2)");
    const sessionId = db.get("SELECT id FROM sessions WHERE session_id = 's1'")!["id"] as number;
    db.run("INSERT INTO turns (session_id, uuid, ordinal, ts, prompt, start_byte) VALUES (?, 'u1', 0, 1, 'fix the login flow', 0)", sessionId);
    expect(db.all("SELECT rowid FROM turns_fts WHERE turns_fts MATCH 'login'")).toHaveLength(1);
    expect(db.all("SELECT rowid FROM sessions_fts WHERE sessions_fts MATCH 'auth'")).toHaveLength(1);
    db.run("DELETE FROM sessions WHERE id = ?", sessionId);
    expect(db.all("SELECT rowid FROM turns_fts WHERE turns_fts MATCH 'login'")).toHaveLength(0);
    expect(db.all("SELECT rowid FROM sessions_fts WHERE sessions_fts MATCH 'auth'")).toHaveLength(0);
    db.close();
});

test("a response overwrite keeps the turns FTS in sync", () => {
    const db = openRecallDb(join(dir, "response.db"));
    db.run("INSERT INTO sessions (session_id, first_ts, last_ts) VALUES ('s1', 1, 2)");
    const sessionId = db.get("SELECT id FROM sessions WHERE session_id = 's1'")!["id"] as number;
    db.run(
        "INSERT INTO turns (session_id, uuid, ordinal, ts, prompt, response, start_byte) VALUES (?, 'u1', 0, 1, 'fix the login flow', 'draft answer', 0)",
        sessionId,
    );
    expect(db.all("SELECT rowid FROM turns_fts WHERE turns_fts MATCH 'draft'")).toHaveLength(1);
    db.run("UPDATE turns SET response = 'rotated the refresh secret' WHERE session_id = ?", sessionId);
    expect(db.all("SELECT rowid FROM turns_fts WHERE turns_fts MATCH 'draft'")).toHaveLength(0);
    expect(db.all("SELECT rowid FROM turns_fts WHERE turns_fts MATCH 'rotated'")).toHaveLength(1);
    db.close();
});
