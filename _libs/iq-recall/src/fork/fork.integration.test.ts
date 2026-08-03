import { existsSync, readFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { makeRecallFixture } from "../testing.js";
import { openRecallDb, type RecallDb } from "../store/db.js";
import { ingest } from "../ingest/ingest.js";
import { type Line, parseLine, parentUuidOf, typeOf, uuidOf } from "../transcript/lines.js";
import { selectForkPoint } from "./fork-point.js";
import { materializeFork } from "./fork.js";

const SESSION_A = "aaaaaaaa-0000-4000-8000-000000000001";

let root: string;
let projectsDir: string;
let cleanup: () => Promise<void>;
let db: RecallDb;

beforeAll(async () => {
    const fixture = await makeRecallFixture();
    ({ root, projectsDir, cleanup } = fixture);
    db = openRecallDb(join(fixture.claudeDir, "recall.db"));
    await ingest(db, { root, projectsDir });
});
afterAll(async () => {
    db.close();
    await cleanup();
});

const transcriptA = (): string => join(projectsDir, `${SESSION_A}.jsonl`);

const parseAll = (path: string): Line[] =>
    readFileSync(path, "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => parseLine(line)!);

test("fork point picks the fullest still-fresh prefix", () => {
    const point = selectForkPoint(db, root, SESSION_A, "JWT refresh token rotation login");
    expect(point?.ordinal).toBe(1);
    expect(point?.staleFiles).toEqual([]);
    expect(point?.coverageFiles).toContain("src/auth/token.ts");
});

test("staleness pushes the fork point back to before the invalidated reads", () => {
    const now = new Date();
    utimesSync(join(root, "src/auth/token.ts"), now, now);
    utimesSync(join(root, "src/auth/token.test.ts"), now, now);
    const point = selectForkPoint(db, root, SESSION_A, "JWT refresh token rotation login");
    expect(point?.ordinal).toBe(0);
    const backdated = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    utimesSync(join(root, "src/auth/token.ts"), backdated, backdated);
    utimesSync(join(root, "src/auth/token.test.ts"), backdated, backdated);
});

test("unknown session or empty relevance yields no fork point", () => {
    expect(selectForkPoint(db, root, "no-such-session")).toBeUndefined();
    expect(selectForkPoint(db, root, SESSION_A, "zz_never_mentioned_zz")).toBeUndefined();
});

test("full fork keeps the active branch, drops bookkeeping, and rewrites the session id", async () => {
    const result = await materializeFork({ transcriptPath: transcriptA() });
    const lines = parseAll(result.path);
    expect(lines).toHaveLength(result.keptLines);
    const types = new Set(lines.map((line) => typeOf(line)));
    for (const dropped of ["queue-operation", "file-history-snapshot", "mode"]) {
        expect(types).not.toContain(dropped);
    }
    const uuids = new Set(lines.map((line) => uuidOf(line)).filter((uuid) => uuid !== undefined));
    expect(uuids).not.toContain("a-dead");
    // Chain integrity: every kept parent resolves within the fork.
    for (const line of lines) {
        const parent = parentUuidOf(line);
        if (parent !== undefined) {
            expect(uuids).toContain(parent);
        }
    }
    for (const line of lines) {
        expect(line["sessionId"]).toBe(result.sessionId);
    }
    // The rewritten transcript ends with fresh ai-title + last-prompt state.
    expect(lines.at(-2)?.["aiTitle"]).toBe("Fix JWT refresh rotation (fork)");
    expect(lines.at(-1)?.["leafUuid"]).toBe("a-a7");
    // The 40 KB padded line survived the roundtrip intact.
    expect(readFileSync(result.path, "utf8")).toContain("x".repeat(40_000));
});

test("--at forks mid-session: everything after the chosen turn is gone", async () => {
    const result = await materializeFork({ transcriptPath: transcriptA(), atTurnUuid: "a-u0" });
    const lines = parseAll(result.path);
    const uuids = new Set(lines.map((line) => uuidOf(line)));
    expect(result.leafUuid).toBe("a-a3");
    expect(uuids).toContain("a-u0");
    expect(uuids).not.toContain("a-u4");
    expect(uuids).not.toContain("a-a7");
    expect(lines.at(-1)?.["lastPrompt"]).toBe("Fix the JWT refresh token rotation in the auth service login flow");
});

test("dry run reports without writing", async () => {
    const result = await materializeFork({ transcriptPath: transcriptA(), atTurnUuid: "a-u0", dryRun: true });
    expect(existsSync(result.path)).toBe(false);
    expect(result.keptLines).toBeGreaterThan(0);
});

test("stale files the fork read are reported with absolute paths", async () => {
    const now = new Date();
    utimesSync(join(root, "src/auth/login.ts"), now, now);
    const result = await materializeFork({ transcriptPath: transcriptA(), atTurnUuid: "a-u0", dryRun: true });
    expect(result.staleFiles).toContain(join(root, "src/auth/login.ts"));
});

test("forking at a non-turn uuid is an error", async () => {
    await expect(materializeFork({ transcriptPath: transcriptA(), atTurnUuid: "a-a1" })).rejects.toThrow("not a user turn");
});
