import { statSync } from "node:fs";
import { appendFile, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { makeRecallFixture } from "../testing.js";
import { openRecallDb, type RecallDb } from "../store/db.js";
import { ingest } from "./ingest.js";

const SESSION_A = "aaaaaaaa-0000-4000-8000-000000000001";
const SESSION_B = "aaaaaaaa-0000-4000-8000-000000000002";

let root: string;
let projectsDir: string;
let cleanup: () => Promise<void>;
let db: RecallDb;

beforeAll(async () => {
    let claudeDir: string;
    ({ root, claudeDir, projectsDir, cleanup } = await makeRecallFixture());
    db = openRecallDb(join(claudeDir, "recall.db"));
});
afterAll(async () => {
    db.close();
    await cleanup();
});

const turnsOf = (sessionId: string): { ordinal: number; prompt: string }[] =>
    db
        .all("SELECT t.ordinal AS ordinal, t.prompt AS prompt FROM turns t JOIN sessions s ON s.id = t.session_id WHERE s.session_id = ? ORDER BY t.ordinal", sessionId)
        .map((row) => ({ ordinal: Number(row["ordinal"]), prompt: row["prompt"] as string }));

const touchesOf = (sessionId: string, ordinal: number): { path: string; modified: number }[] =>
    db
        .all(
            `SELECT tf.path AS path, tf.modified AS modified FROM turn_files tf
             JOIN turns t ON t.id = tf.turn_id JOIN sessions s ON s.id = t.session_id
             WHERE s.session_id = ? AND t.ordinal = ? ORDER BY tf.path`,
            sessionId,
            ordinal,
        )
        .map((row) => ({ path: row["path"] as string, modified: Number(row["modified"]) }));

test("full ingest indexes sessions, turns, touches, and titles", async () => {
    const stats = await ingest(db, { root, projectsDir });
    expect(stats).toEqual({ transcripts: 2, sessions: 2, turns: 3, files: 5 });
    expect(db.get("SELECT title FROM sessions WHERE session_id = ?", SESSION_A)?.["title"]).toBe("Fix JWT refresh rotation");
    expect(turnsOf(SESSION_A)).toEqual([
        { ordinal: 0, prompt: "Fix the JWT refresh token rotation in the auth service login flow" },
        { ordinal: 1, prompt: "Improve the token rotation now and add tests for expiry edge cases" },
    ]);
    // Read-only vs modified, workspace-relative paths, out-of-root touch skipped.
    expect(touchesOf(SESSION_A, 0)).toEqual([
        { path: "package.json", modified: 0 },
        { path: "src/auth/login.ts", modified: 0 },
    ]);
    expect(touchesOf(SESSION_A, 1)).toEqual([
        { path: "src/auth/token.test.ts", modified: 0 },
        { path: "src/auth/token.ts", modified: 1 },
    ]);
});

test("unchanged transcripts are skipped; re-ingest is idempotent", async () => {
    const stats = await ingest(db, { root, projectsDir });
    expect(stats).toEqual({ transcripts: 2, sessions: 2, turns: 3, files: 5 });
});

test("appended lines extend the still-open turn without duplicating anything", async () => {
    const path = join(projectsDir, `${SESSION_A}.jsonl`);
    const ts = new Date().toISOString();
    await appendFile(
        path,
        `${JSON.stringify({
            parentUuid: "a-a7",
            type: "assistant",
            message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_a8", name: "Read", input: { file_path: join(root, "src/web/file-tabs.ts") } }] },
            uuid: "a-a8",
            timestamp: ts,
            sessionId: SESSION_A,
        })}\n`,
    );
    await ingest(db, { root, projectsDir });
    expect(turnsOf(SESSION_A)).toHaveLength(2);
    expect(touchesOf(SESSION_A, 1)).toContainEqual({ path: "src/web/file-tabs.ts", modified: 0 });
});

test("an appended typed prompt opens the next ordinal", async () => {
    const path = join(projectsDir, `${SESSION_A}.jsonl`);
    const ts = new Date().toISOString();
    await appendFile(
        path,
        `${JSON.stringify({
            parentUuid: "a-a8",
            type: "user",
            message: { role: "user", content: [{ type: "text", text: "Also update the changelog" }] },
            uuid: "a-u9",
            timestamp: ts,
            sessionId: SESSION_A,
        })}\n`,
    );
    const stats = await ingest(db, { root, projectsDir });
    expect(stats.turns).toBe(4);
    expect(turnsOf(SESSION_A).at(-1)).toEqual({ ordinal: 2, prompt: "Also update the changelog" });
    const offset = Number(db.get("SELECT byte_offset FROM transcripts WHERE session_id = ?", SESSION_A)?.["byte_offset"]);
    expect(offset).toBe(statSync(path).size);
});

test("a shrunk transcript is reparsed from scratch instead of trusting stale offsets", async () => {
    const path = join(projectsDir, `${SESSION_B}.jsonl`);
    const lines = (await readFile(path, "utf8")).split("\n");
    await writeFile(path, `${lines.slice(0, 3).join("\n")}\n`);
    const stats = await ingest(db, { root, projectsDir });
    expect(stats.sessions).toBe(2);
    expect(turnsOf(SESSION_B)).toEqual([{ ordinal: 0, prompt: "Improve the file icons in the workspace view tabs" }]);
    expect(touchesOf(SESSION_B, 0)).toEqual([{ path: "src/web/file-tabs.ts", modified: 0 }]);
});

test("a deleted transcript loses its rows", async () => {
    await rm(join(projectsDir, `${SESSION_B}.jsonl`));
    const stats = await ingest(db, { root, projectsDir });
    expect(stats.transcripts).toBe(1);
    expect(stats.sessions).toBe(1);
    expect(db.get("SELECT COUNT(*) AS n FROM sessions WHERE session_id = ?", SESSION_B)?.["n"]).toBe(0);
});
