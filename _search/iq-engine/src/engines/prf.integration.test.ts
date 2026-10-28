import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SqliteDb } from "@intentic/base/sqlite";
import { openIndex } from "../store/db.js";
import { replaceFile } from "../store/index-store.js";
import { prfTerms } from "./bm25.js";

let dir: string;
let db: SqliteDb;

const seed = (texts: readonly string[]): void => {
    db.transaction(() => {
        replaceFile(
            db,
            { path: "corpus.txt", repo: undefined, lang: undefined, mtimeMs: 0, size: texts.join("\n").length, hash: "corpus", complexity: 0 },
            [],
            texts.map((text, index) => ({ startLine: index + 1, endLine: index + 1, text, hash: `h${index}` })),
            [],
        );
    });
};

beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "iq-prf-"));
    db = openIndex(dir, "write");
});

beforeEach(() => {
    seed([
        "needle needle common rare_a rare_a rare_b rare_c Café cafe $token snake_case",
        "common background rare_c Café",
        ...Array.from({ length: 98 }, () => "common background"),
    ]);
});

afterAll(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
});

const EXPECTED = ["rare_a", "$token", "rare_b", "snake_case", "cafe", "rare_c"];

test("PRF preserves document frequencies, identifier tokens, common-term exclusion, and lexical ties", () => {
    expect(prfTerms(db, "needle")).toEqual(EXPECTED);
});

test("the vocabulary works on a read-only connection and stays out of the durable schema", () => {
    const reader = openIndex(dir, "read");
    try {
        expect(prfTerms(reader, "needle")).toEqual(EXPECTED);
        expect(reader.all("SELECT name FROM sqlite_schema WHERE name = 'iq_prf_vocabulary'")).toEqual([]);
    } finally {
        reader.close();
    }
});

test("a reused vocabulary sees inserted and deleted FTS postings immediately", () => {
    expect(prfTerms(db, "needle")).toEqual(EXPECTED);
    const fileId = Number(db.get("SELECT id FROM files WHERE path = 'corpus.txt'")!["id"]);
    db.run("INSERT INTO chunks (file_id, start_line, end_line, hash, text) VALUES (?, 500, 500, 'fresh', 'rare_b')", fileId);
    expect(prfTerms(db, "needle")).toEqual(["rare_a", "$token", "snake_case", "cafe", "rare_b", "rare_c"]);
    db.run("DELETE FROM chunks WHERE hash = 'fresh'");
    expect(prfTerms(db, "needle")).toEqual(EXPECTED);
});

test("hundreds of candidate terms use bounded batches without losing terms across a batch boundary", () => {
    seed([
        `needle ${Array.from({ length: 600 }, (_, index) => `term${index}`).join(" ")} zzlast zzlast zzlast`,
        ...Array.from({ length: 99 }, () => "common background"),
    ]);
    let queries = 0;
    const observed: SqliteDb = {
        ...db,
        all: (sql, ...params) => {
            queries += 1;
            return db.all(sql, ...params);
        },
        get: (sql, ...params) => {
            queries += 1;
            return db.get(sql, ...params);
        },
        run: (sql, ...params) => {
            queries += 1;
            db.run(sql, ...params);
        },
    };

    expect(prfTerms(observed, "needle")).toEqual(["zzlast", "term0", "term1", "term10", "term100", "term101", "term102", "term103"]);
    expect(queries).toBeLessThanOrEqual(6);
});

test("stopword-only queries and unmatched queries have no expansion", () => {
    expect(prfTerms(db, "the a an of")).toEqual([]);
    expect(prfTerms(db, "no_such_word_zz")).toEqual([]);
});
