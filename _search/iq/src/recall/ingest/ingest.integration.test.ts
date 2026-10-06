import { statSync } from "node:fs";
import { appendFile, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TURN_PREAMBLE_SEPARATOR } from "@intentic/constants";
import { makeRecallFixture } from "../testing.js";
import type { SqliteDb } from "@intentic/base/sqlite";
import { openRecallDb } from "../store/db.js";
import { ingest } from "./ingest.js";

const SESSION_A = "aaaaaaaa-0000-4000-8000-000000000001";
const SESSION_B = "aaaaaaaa-0000-4000-8000-000000000002";

let root: string;
let projectsDir: string;
let cleanup: () => Promise<void>;
let db: SqliteDb;
let dbPath: string;

beforeAll(async () => {
    let claudeDir: string;
    ({ root, claudeDir, projectsDir, cleanup } = await makeRecallFixture());
    dbPath = join(claudeDir, "recall.db");
    db = openRecallDb(dbPath);
});
afterAll(async () => {
    db.close();
    await cleanup();
});

const turnsOf = (sessionId: string): { ordinal: number; prompt: string }[] =>
    db
        .all(
            "SELECT t.ordinal AS ordinal, t.prompt AS prompt FROM turns t JOIN sessions s ON s.id = t.session_id WHERE s.session_id = ? ORDER BY t.ordinal",
            sessionId,
        )
        .map((row) => ({ ordinal: Number(row["ordinal"]), prompt: row["prompt"] as string }));

const responseOf = (sessionId: string, ordinal: number): string =>
    db.get(
        "SELECT t.response AS response FROM turns t JOIN sessions s ON s.id = t.session_id WHERE s.session_id = ? AND t.ordinal = ?",
        sessionId,
        ordinal,
    )?.["response"] as string;

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
    // The turn's closing assistant message is the stored response: the dead branch is superseded by append
    // order, and an oversized answer is head-capped.
    expect(responseOf(SESSION_A, 0)).toBe("The rotation bug is in token refresh.");
    expect(responseOf(SESSION_A, 1)).toMatch(/^Rotation fixed and tests added\./);
    expect(responseOf(SESSION_A, 1)).toHaveLength(4000);
    expect(responseOf(SESSION_B, 0)).toBe("Icons updated.");
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
            message: {
                role: "assistant",
                content: [{ type: "tool_use", id: "toolu_a8", name: "Read", input: { file_path: join(root, "src/web/file-tabs.ts") } }],
            },
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

test("appended assistant text overwrites the still-open turn's response, FTS included", async () => {
    const path = join(projectsDir, `${SESSION_A}.jsonl`);
    const ts = new Date().toISOString();
    await appendFile(
        path,
        `${JSON.stringify({
            parentUuid: "a-u9",
            type: "assistant",
            message: { role: "assistant", content: [{ type: "text", text: "Changelog entry drafted under Unreleased." }] },
            uuid: "a-a10",
            timestamp: ts,
            sessionId: SESSION_A,
        })}\n`,
    );
    await ingest(db, { root, projectsDir });
    expect(responseOf(SESSION_A, 2)).toBe("Changelog entry drafted under Unreleased.");
    expect(db.all("SELECT rowid FROM turns_fts WHERE turns_fts MATCH 'drafted'")).toHaveLength(1);
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

// Everything unlisted is deleted, so a listing that failed must not read as empty. A symlink loop stands in for
// EACCES/EIO, which a root test run cannot provoke.
test("a transcript dir that fails to list is an error, and every indexed session survives it", async () => {
    const loop = join(root, "projects-loop");
    await symlink(loop, loop);
    await expect(ingest(db, { root, projectsDir: loop })).rejects.toThrow("ELOOP");
    expect(Number(db.get("SELECT COUNT(*) AS n FROM sessions")?.["n"])).toBe(1);
    await rm(loop);
});

/* THE BUDGET, and the contract that makes stopping early safe: byte offsets mean unfinished work is deferred. */
const SESSION_C = "aaaaaaaa-0000-4000-8000-000000000003";

const writeSession = async (sessionId: string, prompt: string): Promise<void> => {
    const ts = new Date().toISOString();
    await writeFile(
        join(projectsDir, `${sessionId}.jsonl`),
        `${[
            JSON.stringify({
                parentUuid: null,
                type: "user",
                message: { role: "user", content: prompt },
                uuid: `${sessionId}-1`,
                timestamp: ts,
                sessionId,
            }),
            JSON.stringify({
                parentUuid: `${sessionId}-1`,
                type: "assistant",
                message: { role: "assistant", content: [{ type: "text", text: "Done." }] },
                uuid: `${sessionId}-2`,
                timestamp: ts,
                sessionId,
            }),
        ].join("\n")}\n`,
    );
};

test("an exhausted budget indexes nothing new rather than overrunning", async () => {
    const before = Number(db.get("SELECT COUNT(*) AS n FROM sessions")?.["n"]);
    await writeSession(SESSION_C, "Add a budget to the recall ingest loop");
    // A deadline already in the past: the loop must stop at its first check, before any parse.
    const stats = await ingest(db, { root, projectsDir, deadlineMs: Date.now() });
    expect(stats.sessions).toBe(before);
    expect(db.get("SELECT COUNT(*) AS n FROM sessions WHERE session_id = ?", SESSION_C)?.["n"]).toBe(0);
});

test("what a budget skipped is picked up by the next run", async () => {
    const stats = await ingest(db, { root, projectsDir });
    expect(stats.sessions).toBe(2);
    expect(turnsOf(SESSION_C)).toEqual([{ ordinal: 0, prompt: "Add a budget to the recall ingest loop" }]);
});

/* THE DAEMON'S TURN PREAMBLE: indexed prompts are the user's words, the notes in front of them are not. */
const SESSION_D = "aaaaaaaa-0000-4000-8000-000000000004";

test("an ingested turn with a daemon preamble is indexed without it", async () => {
    const preamble = `## Map of this project\n\nYou are at the top of the workspace: four orientation areas.${TURN_PREAMBLE_SEPARATOR}`;
    await writeSession(SESSION_D, `${preamble}Rename the token helper`);
    await ingest(db, { root, projectsDir });
    expect(turnsOf(SESSION_D)).toEqual([{ ordinal: 0, prompt: "Rename the token helper" }]);
    // No row anywhere carries the note's words, FTS included: "orientation" appears only in the preamble.
    expect(db.all("SELECT rowid FROM turns_fts WHERE turns_fts MATCH 'orientation'")).toEqual([]);
});

/* TWO INGESTS AT ONCE: the prompt hook's budgeted pass and the SessionStart background pass overlap. */
const SESSION_E = "aaaaaaaa-0000-4000-8000-000000000005";

test("two ingests racing over the same new transcript store each turn once", async () => {
    await writeSession(SESSION_E, "Cache the fleet registry lookup");
    // A second handle on the same file, as a second process holds: both read the transcript's offset before either
    // writes, so both parse and apply the same delta.
    const other = openRecallDb(dbPath);
    try {
        await Promise.all([ingest(db, { root, projectsDir }), ingest(other, { root, projectsDir })]);
    } finally {
        other.close();
    }
    expect(turnsOf(SESSION_E)).toEqual([{ ordinal: 0, prompt: "Cache the fleet registry lookup" }]);
    expect(db.all("SELECT rowid FROM turns_fts WHERE turns_fts MATCH 'fleet'")).toHaveLength(1);
});
