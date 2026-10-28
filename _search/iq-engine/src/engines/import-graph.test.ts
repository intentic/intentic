import { IN_MEMORY, openSqlite, type SqliteDb, wrapDb } from "@intentic/base/sqlite";
import { buildImportGraph, fileHeads } from "./import-graph.js";

let db: SqliteDb;
let nextId: number;
let paths: Set<string>;

beforeEach(() => {
    const raw = openSqlite(IN_MEMORY);
    raw.exec(`
        CREATE TABLE files (id INTEGER PRIMARY KEY, path TEXT NOT NULL);
        CREATE TABLE chunks (id INTEGER PRIMARY KEY, file_id INTEGER NOT NULL, text TEXT NOT NULL);
        CREATE TABLE imports (file_id INTEGER NOT NULL, specifier TEXT NOT NULL);
    `);
    db = wrapDb(raw);
    nextId = 0;
    paths = new Set();
});

afterEach(() => db.close());

const file = (path: string, text = ""): number => {
    const id = ++nextId;
    db.run("INSERT INTO files (id, path) VALUES (?, ?)", id, path);
    db.run("INSERT INTO chunks (file_id, text) VALUES (?, ?)", id, text);
    paths.add(path);
    return id;
};

const imports = (from: number, ...specifiers: string[]): void => {
    for (const specifier of specifiers) {
        db.run("INSERT INTO imports (file_id, specifier) VALUES (?, ?)", from, specifier);
    }
};

const graph = (allowed: ReadonlySet<string> = paths) => buildImportGraph(db, allowed, fileHeads(db));

test("an exact filename takes precedence over TypeScript rewrites", () => {
    const source = file("src/source.ts");
    const exact = file("src/widget.js");
    file("src/widget.ts");
    imports(source, "./widget.js");

    const result = graph();
    expect(result.imports).toEqual(new Map([[source, new Set([exact])]]));
    expect(result.importedBy).toEqual(new Map([[exact, new Set([source])]]));
});

test.each([".js", ".jsx", ".mjs", ".cjs"])("%s imports try .ts, .tsx, then .mts before appended suffixes", (extension) => {
    const source = file("src/source.ts");
    const ts = file("src/plain.ts");
    file("src/plain.tsx");
    file("src/plain.mts");
    file(`src/plain${extension}.ts`);
    const tsx = file("src/component.tsx");
    file("src/component.mts");
    const mts = file("src/module.mts");
    imports(source, `./plain${extension}`, `./component${extension}`, `./module${extension}`);

    expect(graph().imports.get(source)).toEqual(new Set([ts, tsx, mts]));
});

test("extensionless files and directory entry points retain their candidate order", () => {
    const source = file("src/source.ts");
    const direct = file("src/direct.ts");
    file("src/direct.tsx");
    file("src/direct/index.ts");
    const index = file("src/folder/index.tsx");
    file("src/folder/main.ts");
    const main = file("src/python/main.py");
    file("src/python/mod.ts");
    const mod = file("src/rust/mod.rs");
    imports(source, "./direct", "./folder", "./python", "./rust");

    expect(graph().imports.get(source)).toEqual(new Set([direct, index, main, mod]));
});

test("relative imports normalize dot segments from the importing file's directory", () => {
    const source = file("src/nested/source.ts");
    const target = file("src/widget.ts");
    imports(source, ".././widget.js", "../../src/widget.js");

    expect(graph().imports.get(source)).toEqual(new Set([target]));
});

test("the longest package prefix owns bare imports, with root files before src fallbacks", () => {
    const source = file("app/source.ts");
    file("packages/short/package.json", JSON.stringify({ name: "@suite" }));
    file("packages/core/package.json", JSON.stringify({ name: "@suite/core" }));
    file("packages/short/core/util.ts");
    const util = file("packages/core/util.ts");
    file("packages/core/src/util.ts");
    const feature = file("packages/core/src/feature.ts");
    const entry = file("packages/core/index.ts");
    file("packages/core/src/index.ts");
    imports(source, "@suite/core/util", "@suite/core/feature", "@suite/core");

    expect(graph().imports.get(source)).toEqual(new Set([util, feature, entry]));
});

test("package ownership ends at a slash boundary and supports unscoped names", () => {
    const source = file("app/source.ts");
    file("packages/lib/package.json", JSON.stringify({ name: "lib" }));
    const entry = file("packages/lib/src/index.ts");
    const util = file("packages/lib/src/util.ts");
    file("packages/lib/rary.ts");
    imports(source, "lib", "lib/util", "library", "node:fs", "external");

    expect(graph().imports.get(source)).toEqual(new Set([entry, util]));
});

test("scoped graphs exclude outside targets, unresolved imports, and self edges", () => {
    const source = file("src/source.ts");
    file("src/outside.ts");
    const target = file("src/target.ts");
    imports(source, "./outside.js", "./source.js", "./missing.js", "./target.js", "./target.js");
    imports(target, "./source.js");

    const result = graph(new Set(["src/source.ts", "src/target.ts"]));
    expect(result.pathsById).toEqual(
        new Map([
            [source, "src/source.ts"],
            [target, "src/target.ts"],
        ]),
    );
    expect(result.idByPath).toEqual(
        new Map([
            ["src/source.ts", source],
            ["src/target.ts", target],
        ]),
    );
    expect(result.imports).toEqual(
        new Map([
            [source, new Set([target])],
            [target, new Set([source])],
        ]),
    );
    expect(result.importedBy).toEqual(
        new Map([
            [target, new Set([source])],
            [source, new Set([target])],
        ]),
    );
});

test("a later graph resolves against the current file set", () => {
    const source = file("src/source.ts");
    imports(source, "./widget.js");
    expect(graph().imports).toEqual(new Map());

    const target = file("src/widget.ts");
    expect(graph().imports.get(source)).toEqual(new Set([target]));
});
