import { readFileSync, statSync } from "node:fs";
import { rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import type { SqliteDb } from "@intentic/base/sqlite";
import { makeRecallFixture } from "../testing.js";
import { openRecallDb } from "../store/db.js";
import { ingest } from "./ingest.js";

// A transcript the sandbox compressed beside itself once it went cold (`<id>.jsonl.zst`, the daemon's
// sessions/cold-sessions.ts): it is still that session's transcript to recall, whether it was indexed before or not.

const SESSION_A = "aaaaaaaa-0000-4000-8000-000000000001";
const SESSION_B = "aaaaaaaa-0000-4000-8000-000000000002";

let root: string;
let projectsDir: string;
let claudeDir: string;
let cleanup: () => Promise<void>;
const dbs: SqliteDb[] = [];

beforeEach(async () => {
    ({ root, claudeDir, projectsDir, cleanup } = await makeRecallFixture());
});
afterEach(async () => {
    dbs.splice(0).forEach((db) => db.close());
    await cleanup();
});

const freshDb = (name: string): SqliteDb => {
    const db = openRecallDb(join(claudeDir, name));
    dbs.push(db);
    return db;
};

const transcriptOf = (sessionId: string): string => join(projectsDir, `${sessionId}.jsonl`);

// As the sandbox does it: `<id>.jsonl.zst` under the plain file's own mtime, then the plain file gone.
const compress = async (sessionId: string, bytes: Buffer = zstdCompressSync(readFileSync(transcriptOf(sessionId)))): Promise<void> => {
    const plain = statSync(transcriptOf(sessionId));
    await writeFile(`${transcriptOf(sessionId)}.zst`, bytes);
    await utimes(`${transcriptOf(sessionId)}.zst`, plain.atime, plain.mtime);
    await rm(transcriptOf(sessionId));
};

const rowsOf = (db: SqliteDb, sessionId: string): unknown[] =>
    db.all(
        `SELECT t.ordinal AS ordinal, t.prompt AS prompt, t.response AS response, t.start_byte AS start_byte
         FROM turns t JOIN sessions s ON s.id = t.session_id WHERE s.session_id = ? ORDER BY t.ordinal`,
        sessionId,
    );

const filesOf = (db: SqliteDb, sessionId: string): unknown[] =>
    db.all(
        `SELECT t.ordinal AS ordinal, tf.path AS path, tf.modified AS modified FROM turn_files tf
         JOIN turns t ON t.id = tf.turn_id JOIN sessions s ON s.id = t.session_id WHERE s.session_id = ? ORDER BY t.ordinal, tf.path`,
        sessionId,
    );

test("a transcript compressed after it was indexed keeps its rows, and is not read again", async () => {
    const db = freshDb("recall.db");
    const before = await ingest(db, { root, projectsDir });
    const turns = rowsOf(db, SESSION_A);
    const files = filesOf(db, SESSION_A);
    // Bytes that do not decompress: a pass that read the file again would fail on them.
    await compress(SESSION_A, Buffer.from("not zstd at all"));
    expect(await ingest(db, { root, projectsDir })).toEqual(before);
    expect(rowsOf(db, SESSION_A)).toEqual(turns);
    expect(filesOf(db, SESSION_A)).toEqual(files);
});

test("a compressed transcript never indexed is read through zstd, as its plain file would have been", async () => {
    const plain = freshDb("plain.db");
    await ingest(plain, { root, projectsDir });
    const size = statSync(transcriptOf(SESSION_B)).size;
    const text = readFileSync(transcriptOf(SESSION_B));
    await compress(SESSION_B);

    const db = freshDb("recall.db");
    expect(await ingest(db, { root, projectsDir })).toEqual(await ingest(plain, { root, projectsDir }));
    expect(rowsOf(db, SESSION_B)).toEqual(rowsOf(plain, SESSION_B));
    expect(filesOf(db, SESSION_B)).toEqual(filesOf(plain, SESSION_B));
    expect(db.get("SELECT size, byte_offset FROM transcripts WHERE session_id = ?", SESSION_B)).toEqual({ size, byte_offset: size });

    // Plain again, under the same mtime as the sandbox thaws it: the index already holds it, so nothing is read twice.
    const packed = statSync(`${transcriptOf(SESSION_B)}.zst`);
    await writeFile(transcriptOf(SESSION_B), text);
    await utimes(transcriptOf(SESSION_B), packed.atime, packed.mtime);
    await rm(`${transcriptOf(SESSION_B)}.zst`);
    const rows = rowsOf(db, SESSION_B);
    await ingest(db, { root, projectsDir });
    expect(rowsOf(db, SESSION_B)).toEqual(rows);
});

test("a name found both plain and compressed is read as the plain file", async () => {
    await writeFile(`${transcriptOf(SESSION_A)}.zst`, "not zstd at all");
    const db = freshDb("recall.db");
    expect((await ingest(db, { root, projectsDir })).transcripts).toBe(2);
    expect(db.get("SELECT path FROM transcripts WHERE session_id = ?", SESSION_A)).toEqual({ path: transcriptOf(SESSION_A) });
});
