import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { makeRecallFixture } from "../testing.js";
import { openRecallDb, type RecallDb } from "../store/db.js";
import { ingest } from "../ingest/ingest.js";
import { rankFilesForTopic } from "./files.js";
import { grabExcerpts } from "./grab.js";
import { matchSessions } from "./match.js";

const SESSION_A = "aaaaaaaa-0000-4000-8000-000000000001";
const SESSION_B = "aaaaaaaa-0000-4000-8000-000000000002";

let cleanup: () => Promise<void>;
let db: RecallDb;

beforeAll(async () => {
    const fixture = await makeRecallFixture();
    cleanup = fixture.cleanup;
    db = openRecallDb(join(fixture.claudeDir, "recall.db"));
    await ingest(db, { root: fixture.root, projectsDir: fixture.projectsDir });
});
afterAll(async () => {
    db.close();
    await cleanup();
});

test("topic query surfaces the session's files; ubiquitous files are idf-zeroed out", () => {
    const files = rankFilesForTopic(db, "JWT refresh token rotation");
    const paths = files.map((file) => file.path);
    expect(paths).toContain("src/auth/token.ts");
    expect(paths).toContain("src/auth/login.ts");
    // package.json was touched in every session — ln((2+1)/(1+2)) = 0 kills it.
    expect(paths).not.toContain("package.json");
    expect(paths).not.toContain("src/web/file-tabs.ts");
});

test("recency decay ranks the fresher association higher on a shared term", () => {
    // "improve" appears in session A's turn 1 (2 days old) and session B's turn 0 (20 days old).
    const paths = rankFilesForTopic(db, "improve").map((file) => file.path);
    expect(paths.indexOf("src/auth/token.ts")).toBeGreaterThanOrEqual(0);
    expect(paths.indexOf("src/auth/token.ts")).toBeLessThan(paths.indexOf("src/web/file-tabs.ts"));
});

test("empty and operator-only queries return nothing instead of breaking FTS", () => {
    expect(rankFilesForTopic(db, "")).toEqual([]);
    expect(rankFilesForTopic(db, '(" OR ')).toEqual([]);
    expect(rankFilesForTopic(db, "zz_never_mentioned_zz")).toEqual([]);
});

test("matchSessions finds the related session and marks it strong", () => {
    const matches = matchSessions(db, "fix the JWT refresh token rotation in the auth service");
    expect(matches[0]?.sessionId).toBe(SESSION_A);
    expect(matches[0]?.strong).toBe(true);
    expect(matches[0]?.title).toBe("Fix JWT refresh rotation");
});

test("the current session is excluded — a session must never suggest forking itself", () => {
    const matches = matchSessions(db, "fix the JWT refresh token rotation in the auth service", { excludeSessionId: SESSION_A });
    expect(matches.every((match) => match.sessionId !== SESSION_A)).toBe(true);
});

test("an unrelated prompt produces no strong match", () => {
    const matches = matchSessions(db, "provision the kubernetes ingress for the payments cluster");
    expect(matches.every((match) => !match.strong)).toBe(true);
});

test("file overlap lifts the score when caller passes known-relevant files", () => {
    const without = matchSessions(db, "improve the token rotation");
    const withFiles = matchSessions(db, "improve the token rotation", { files: ["src/auth/token.ts", "src/auth/login.ts"] });
    const scoreOf = (matches: typeof without): number => matches.find((match) => match.sessionId === SESSION_A)!.score;
    expect(scoreOf(withFiles)).toBeGreaterThan(0);
    expect(withFiles.find((match) => match.sessionId === SESSION_A)).toBeDefined();
});

test("the days window drops old sessions entirely", () => {
    const matches = matchSessions(db, "improve the file icons in the workspace view tabs", { days: 10 });
    expect(matches.every((match) => match.sessionId !== SESSION_B)).toBe(true);
});

test("grab returns ranked asked→answered excerpts with fork coordinates", () => {
    const excerpts = grabExcerpts(db, "JWT refresh token rotation");
    const top = excerpts[0]!;
    expect(top.sessionId).toBe(SESSION_A);
    expect(top.ordinal).toBe(0);
    expect(top.turnUuid).toBe("a-u0");
    expect(top.title).toBe("Fix JWT refresh rotation");
    expect(top.prompt).toContain("Fix the JWT refresh token rotation");
    expect(top.fragment).toContain("token refresh");
});

test("grab matches vocabulary that only appears in the answer, never the prompt", () => {
    // "bug" occurs solely in session A's turn-0 response.
    const excerpts = grabExcerpts(db, "rotation bug");
    expect(excerpts[0]?.sessionId).toBe(SESSION_A);
    expect(excerpts[0]?.ordinal).toBe(0);
    expect(excerpts[0]?.fragment).toContain("rotation bug");
});

test("grab excludes the current session and honors the days window", () => {
    expect(grabExcerpts(db, "JWT refresh token rotation", { excludeSessionId: SESSION_A })).toHaveLength(0);
    expect(grabExcerpts(db, "file icons workspace", { days: 10 })).toHaveLength(0);
    expect(grabExcerpts(db, "file icons workspace").map((excerpt) => excerpt.sessionId)).toContain(SESSION_B);
});

test("grab tolerates empty and operator-only queries", () => {
    expect(grabExcerpts(db, "")).toEqual([]);
    expect(grabExcerpts(db, '(" OR ')).toEqual([]);
});

/* Bookends: a hit in the middle of a session carries what that session opened and closed on. Session A has two
 * turns, so its first and last differ — which is the case the field exists for. */
test("grab carries the session's bookends so a mid-session hit has provenance", () => {
    const top = grabExcerpts(db, "JWT refresh token rotation")[0]!;
    expect(top.bookends?.turns).toBe(2);
    expect(top.bookends?.first).toContain("Fix the JWT refresh token rotation");
    expect(top.bookends?.last).not.toBe(top.bookends?.first);
});

/* Repeat collapse: the starvation guard. Five sessions running the same nightly prompt must not take five of
 * the ten slots — they collapse to their best instance, which carries the count. Rows are inserted directly
 * (the FTS triggers index them) with a vocabulary no other test queries, so the shared fixture is undisturbed. */
test("near-identical prompts across sessions collapse to one row carrying the repeat count", () => {
    const base = Date.now() - 60 * 60 * 1000;
    for (let i = 0; i < 5; i += 1) {
        db.run(
            `INSERT INTO sessions (session_id, slug, title, version, git_branch, first_ts, last_ts) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            `bbbbbbbb-0000-4000-8000-00000000000${i}`,
            "proj",
            `Nightly zzquux audit ${i}`,
            "1",
            "main",
            base + i,
            base + i,
        );
        const sessionRowId = Number(db.get(`SELECT id FROM sessions WHERE session_id = ?`, `bbbbbbbb-0000-4000-8000-00000000000${i}`)!["id"]);
        db.run(
            `INSERT INTO turns (session_id, uuid, ordinal, ts, prompt, response, start_byte) VALUES (?, ?, 0, ?, ?, ?, 0)`,
            sessionRowId,
            `b-u${i}`,
            base + i,
            // The date is what differs between fires — exactly what the digit-flattening key ignores.
            `Run the nightly zzquux audit for 2026-08-0${i}`,
            "zzquux audit complete",
        );
    }
    const excerpts = grabExcerpts(db, "nightly zzquux audit");
    expect(excerpts).toHaveLength(1);
    expect(excerpts[0]?.repeats).toBe(4);
});

// A genuinely distinct prompt is never folded into another, however similar the topic.
test("distinct prompts on the same topic stay separate rows", () => {
    const excerpts = grabExcerpts(db, "JWT refresh token rotation");
    expect(excerpts.every((excerpt) => excerpt.repeats === 0)).toBe(true);
});
