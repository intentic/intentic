import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SqliteDb } from "@intentic/base/sqlite";
import { extractSymbols } from "../indexer/symbols.js";
import { openIndex } from "../store/db.js";
import { replaceFile } from "../store/index-store.js";
import { readOf } from "./context.js";

const PICKED = "export const picked = () => 'picked';";
const OUTER_RUN = "    run() { return 'outer'; }";
const fixtures = [
    {
        path: "subject.ts",
        content: [
            PICKED,
            "export class Outer {",
            OUTER_RUN,
            "}",
            "class Other {",
            "    run() { return 'other'; }",
            "}",
            "export const run = () => 'module';",
        ].join("\n"),
    },
    { path: "second.ts", content: "export const picked = () => 'second';\nexport const run = () => 'second run';" },
    {
        path: "unrelated.ts",
        content: Array.from({ length: 1_000 }, (_, index) => `export const unrelated${index} = ${index};`).join("\n"),
    },
].map((fixture) => ({ ...fixture, symbols: extractSymbols(fixture.path, "ts", fixture.content) }));

const allowed = new Set(["subject.ts", "second.ts"]);
const namedCount = (name: string): number =>
    fixtures.reduce((sum, fixture) => sum + fixture.symbols.filter((symbol) => symbol.name === name).length, 0);
const subjectCount = fixtures[0]!.symbols.length;

let root: string;
let db: SqliteDb;

beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "iq-read-scale-"));
    db = openIndex(join(root, "index"), "write");
    await Promise.all(fixtures.map((fixture) => writeFile(join(root, fixture.path), fixture.content)));
    db.transaction(() => {
        for (const fixture of fixtures) {
            replaceFile(
                db,
                {
                    path: fixture.path,
                    repo: undefined,
                    lang: "ts",
                    mtimeMs: 0,
                    size: Buffer.byteLength(fixture.content),
                    hash: fixture.path,
                    complexity: 0,
                },
                fixture.symbols,
                [],
                [],
            );
        }
    });
});

afterAll(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
});

// Count the data materialized, not milliseconds: adding unrelated symbols must not make a read fetch the corpus.
const reading = () => {
    const stats = { rows: 0, queries: 0 };
    const observed: SqliteDb = {
        ...db,
        all: (sql, ...params) => {
            const rows = db.all(sql, ...params);
            stats.rows += rows.length;
            stats.queries += 1;
            return rows;
        },
    };
    return { observed, stats };
};

test("a bare name reads its definitions without loading unrelated symbols", async () => {
    const { observed, stats } = reading();
    const result = await readOf(observed, root, "picked", 0, allowed);

    expect(result.groups.map((group) => group.path)).toEqual(["second.ts", "subject.ts"]);
    expect(result.groups.flatMap((group) => group.hits.map((hit) => hit.text))).toEqual(["export const picked = () => 'second';", PICKED]);
    expect(stats.rows).toBeLessThanOrEqual(namedCount("picked"));
});

test("a path-qualified name needs no sibling symbols", async () => {
    const { observed, stats } = reading();
    const result = await readOf(observed, root, "subject.ts::picked", 0, allowed);

    expect(result.groups.map((group) => group.path)).toEqual(["subject.ts"]);
    expect(result.groups[0]!.hits.map((hit) => hit.text)).toEqual([PICKED]);
    expect(stats.rows).toBeLessThanOrEqual(namedCount("picked"));
});

test.each(["Outer::run", "subject.ts::Outer::run"])("%s loads siblings once per admitted candidate file", async (query) => {
    const { observed, stats } = reading();
    const result = await readOf(observed, root, query, 0, new Set(["subject.ts"]));

    expect(result.groups.map((group) => group.path)).toEqual(["subject.ts"]);
    expect(result.groups[0]!.hits.map((hit) => hit.text)).toEqual([OUTER_RUN]);
    expect(stats.rows).toBeLessThanOrEqual(namedCount("run") + subjectCount);
    // Three same-name declarations in this file share one sibling reading.
    expect(stats.queries).toBeLessThanOrEqual(2);
});

test("a missing name materializes no symbol rows", async () => {
    const { observed, stats } = reading();
    const result = await readOf(observed, root, "noSuchSymbol", 0, allowed);

    expect(result.groups).toEqual([]);
    expect(result.label).toBe("noSuchSymbol — no symbol by that name in the workspace");
    expect(stats.rows).toBe(0);
});

test("candidates outside the allowed set never trigger sibling reads", async () => {
    const { observed, stats } = reading();
    const result = await readOf(observed, root, "Outer::run", 0, new Set());

    expect(result.groups).toEqual([]);
    expect(stats.rows).toBeLessThanOrEqual(namedCount("run"));
});
