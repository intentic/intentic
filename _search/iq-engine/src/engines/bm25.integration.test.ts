import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { openIndex, type IndexDb } from "../store/db.js";
import { bm25Search, toMatch } from "./bm25.js";

let dir: string;
let db: IndexDb;

const insertChunk = (fileId: number, line: number, text: string): void => {
    db.run(
        "INSERT INTO chunks (file_id, start_line, end_line, hash, text) VALUES (?, ?, ?, ?, ?)",
        fileId,
        line,
        line + 4,
        `h${fileId}-${line}`,
        text,
    );
};

beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "iq-bm25-"));
    db = openIndex(dir, "write");
    db.run("INSERT INTO files (path, mtime_ms, size, hash) VALUES ('a/ignore-model.ts', 0, 1, 'h1')");
    db.run("INSERT INTO files (path, mtime_ms, size, hash) VALUES ('b/common.ts', 0, 1, 'h2')");
    // "enforced" is rare (1 chunk), "the"/"model" common: BM25 must rank the rare-term chunk first.
    insertChunk(1, 1, "a/ignore-model.ts § floor\nthe ignore model is enforced during the sweep and every engine");
    insertChunk(2, 1, "b/common.ts § one\nthe model the model the model repeated words");
    insertChunk(2, 10, "b/common.ts § two\nthe ignore comment marker");
    insertChunk(2, 20, "b/common.ts § snake\nconst create_widget_scope = build($special)");
});
afterAll(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
});

test("toMatch strips stopwords, quotes terms, and is MATCH-injection safe", () => {
    expect(toMatch("where is the ignore model enforced?")).toBe('"ignore" OR "model" OR "enforced"');
    expect(toMatch("the a an of")).toBeUndefined();
    // Quotes/parens/NEAR syntax in user input never reach the MATCH parser.
    expect(() => bm25Search(db, 'ignore" OR (NEAR "x', new Set(["a/ignore-model.ts"]))).not.toThrow();
});

test("BM25 ranks rarity: the enforced-mention outranks common-word repetition", () => {
    const hits = bm25Search(db, "where is the ignore model enforced?", new Set(["a/ignore-model.ts", "b/common.ts"]));
    expect(hits[0]?.path).toBe("a/ignore-model.ts");
    expect(hits[0]?.tags[0]?.kind).toBe("bm25");
    expect(hits[0]?.tags[0]?.score).toBeGreaterThan(0);
});

test("snake_case and $ identifiers stay whole tokens", () => {
    const hits = bm25Search(db, "create_widget_scope", new Set(["a/ignore-model.ts", "b/common.ts"]));
    expect(hits.map((hit) => `${hit.path}:${hit.line}`)).toEqual(["b/common.ts:20"]);
});

test("allowed-set filter applies (floor enforcement point)", () => {
    const hits = bm25Search(db, "ignore model enforced", new Set(["b/common.ts"]));
    expect(hits.every((hit) => hit.path === "b/common.ts")).toBe(true);
});

test("FTS index tracks chunk deletes (triggers fire on FK cascade)", () => {
    db.run("INSERT INTO files (path, mtime_ms, size, hash) VALUES ('c/temp.ts', 0, 1, 'h3')");
    const id = Number(db.get("SELECT id FROM files WHERE path = 'c/temp.ts'")!["id"]);
    insertChunk(id, 1, "c/temp.ts § tmp\nzzuniquetoken lives here");
    expect(bm25Search(db, "zzuniquetoken", new Set(["c/temp.ts"]))).toHaveLength(1);
    db.run("DELETE FROM files WHERE id = ?", id);
    expect(bm25Search(db, "zzuniquetoken", new Set(["c/temp.ts"]))).toHaveLength(0);
    db.run("INSERT INTO chunks_fts(chunks_fts) VALUES('integrity-check')");
});
