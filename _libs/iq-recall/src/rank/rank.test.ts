import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { makeRecallFixture } from "../testing.js";
import { openRecallDb, type RecallDb } from "../store/db.js";
import { ingest } from "../ingest/ingest.js";
import { rankFilesForTopic } from "./files.js";
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
