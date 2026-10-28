import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SqliteDb } from "@intentic/base/sqlite";
import { openIndex } from "../store/db.js";
import { replaceFile } from "../store/index-store.js";
import type { SymbolRow } from "../types.js";
import { symSearch } from "./symbols.js";

const symbol = (name: string, kind: SymbolRow["kind"], line: number, heuristic = false): SymbolRow => ({
    name,
    kind,
    line,
    endLine: line,
    signature: name,
    exported: false,
    heuristic,
});
const unusualPath = "odd/quo'te\"_[%]\\é.ts";
const emptyPaths = Array.from({ length: 1_200 }, (_, index) => `empty/${index}.ts`);
const fixtures = [
    {
        path: "a.ts",
        symbols: [
            symbol("parse", "fn", 10),
            symbol("parse", "fn", 2),
            symbol("Parser", "class", 20),
            symbol("parseMore", "method", 30, true),
            symbol("p_a_r_s_e", "fn", 40),
        ],
    },
    { path: "b.ts", symbols: [symbol("parse", "fn", 1)] },
    { path: "a.tsx", symbols: [symbol("parse", "fn", 1)] },
    { path: unusualPath, symbols: [symbol("parse", "fn", 1)] },
    {
        path: "excluded.ts",
        symbols: [symbol("parse", "fn", 1), ...Array.from({ length: 1_000 }, (_, index) => symbol(`unrelated${index}`, "const", index + 2))],
    },
    ...emptyPaths.map((path) => ({ path, symbols: [] })),
];
const allowed = new Set(["a.ts", "b.ts"]);
let dir: string;
let db: SqliteDb;

beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "iq-symbols-"));
    db = openIndex(dir, "write");
    db.transaction(() => {
        for (const fixture of fixtures) {
            replaceFile(
                db,
                { path: fixture.path, repo: undefined, lang: "ts", mtimeMs: 0, size: 0, hash: fixture.path, complexity: 0 },
                fixture.symbols,
                [],
                [],
            );
        }
    });
});

afterAll(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
});

// Bound materialized rows rather than elapsed time, so unrelated files cannot restore the corpus-sized read.
const observe = () => {
    const stats = { rows: 0, queries: 0 };
    const observed: SqliteDb = {
        ...db,
        all: (sql, ...params) => {
            const rows = db.all(sql, ...params);
            stats.rows += rows.length;
            stats.queries += 1;
            return rows;
        },
        get: (sql, ...params) => {
            stats.queries += 1;
            return db.get(sql, ...params);
        },
    };
    return { observed, stats };
};

test("a scoped fuzzy search preserves ranking, line order and definition tags without fetching excluded symbols", () => {
    const { observed, stats } = observe();
    expect(symSearch(observed, "parse", undefined, allowed)).toEqual([
        { path: "a.ts", line: 2, text: "fn     parse", tags: [{ kind: "def" }] },
        { path: "a.ts", line: 10, text: "fn     parse", tags: [{ kind: "def" }] },
        { path: "b.ts", line: 1, text: "fn     parse", tags: [{ kind: "def" }] },
        { path: "a.ts", line: 20, text: "class  Parser", tags: [{ kind: "def" }] },
        { path: "a.ts", line: 30, text: "method parseMore", tags: [{ kind: "def" }, { kind: "heuristic" }] },
        { path: "a.ts", line: 40, text: "fn     p_a_r_s_e", tags: [{ kind: "def" }] },
    ]);
    expect(stats.rows).toBe(6);
});

test("kind and scope narrow the same query", () => {
    const { observed, stats } = observe();
    expect(symSearch(observed, "parse", "fn", allowed).map((hit) => [hit.path, hit.line])).toEqual([
        ["a.ts", 2],
        ["a.ts", 10],
        ["b.ts", 1],
        ["a.ts", 40],
    ]);
    expect(stats.rows).toBe(4);
});

test("glob searches preserve heuristic definitions", () => {
    expect(symSearch(db, "*More", undefined, allowed)).toEqual([
        { path: "a.ts", line: 30, text: "method parseMore", tags: [{ kind: "def" }, { kind: "heuristic" }] },
    ]);
});

test("scope paths match exactly, including quotes, wildcards, backslashes and Unicode", () => {
    const { observed, stats } = observe();
    expect(symSearch(observed, "parse", undefined, new Set([unusualPath]))).toEqual([
        { path: unusualPath, line: 1, text: "fn     parse", tags: [{ kind: "def" }] },
    ]);
    expect(stats.rows).toBe(1);
});

test("an empty scope does not query the index", () => {
    const { observed, stats } = observe();
    expect(symSearch(observed, "parse", undefined, new Set())).toEqual([]);
    expect(stats).toEqual({ rows: 0, queries: 0 });
});

test("a scope with more than a thousand paths includes indexed files and ignores missing ones", () => {
    const { observed, stats } = observe();
    const large = new Set(["a.ts", ...Array.from({ length: 1_100 }, (_, index) => `unindexed/${index}.ts`)]);
    expect(symSearch(observed, "parse", undefined, large).map((hit) => [hit.path, hit.line])).toEqual([
        ["a.ts", 2],
        ["a.ts", 10],
        ["a.ts", 20],
        ["a.ts", 30],
        ["a.ts", 40],
    ]);
    expect(stats.rows).toBe(5);
});

test("a scope larger than the index still excludes paths outside its membership", () => {
    const large = new Set(["a.ts", ...Array.from({ length: fixtures.length }, (_, index) => `unindexed/${index}.ts`)]);
    expect(symSearch(db, "parse", "fn", large).map((hit) => [hit.path, hit.line])).toEqual([
        ["a.ts", 2],
        ["a.ts", 10],
        ["a.ts", 40],
    ]);
});

test("a full workspace scope returns definitions from every indexed file", () => {
    const all = new Set(fixtures.map((fixture) => fixture.path));
    expect(symSearch(db, "parse", "fn", all).map((hit) => [hit.path, hit.line])).toEqual([
        ["a.ts", 2],
        ["a.ts", 10],
        ["a.tsx", 1],
        ["b.ts", 1],
        ["excluded.ts", 1],
        [unusualPath, 1],
        ["a.ts", 40],
    ]);
});

test("scoped searches work on a read-only connection", () => {
    const reader = openIndex(dir, "read");
    try {
        expect(symSearch(reader, "parse", "fn", new Set(["b.ts"]))).toEqual([
            { path: "b.ts", line: 1, text: "fn     parse", tags: [{ kind: "def" }] },
        ]);
    } finally {
        reader.close();
    }
});
