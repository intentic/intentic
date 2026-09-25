// Pins what verify:turn measures of a change: every package the change reaches is typechecked, an asset-only package
// stops that walk, and only the test files whose value imports reach a changed file are run, all of a package's suite
// when a file every suite loads changed.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { readWorkspaceGraph } from "../../checks/lib/workspace-graph.mjs";
import { relatedTests, turnClosure } from "./turn-closure.mjs";

// A workspace of four packages: `web` (an editor), `page` (a built page bundling web, exporting only its html), `daemon`
// (serving that page) and `contract` (read by web and daemon alike).
const workspace = () => {
    const root = mkdtempSync(join(tmpdir(), "turn-closure-"));
    const write = (path, text) => {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), text);
    };
    const manifest = (dir, name, deps, extra = {}) =>
        write(`${dir}/package.json`, JSON.stringify({ name, dependencies: Object.fromEntries(deps.map((dep) => [dep, "workspace:*"])), ...extra }));
    write("pnpm-workspace.yaml", "packages:\n  - pkgs/*\n");
    manifest("pkgs/contract", "@x/contract", [], { exports: { ".": "./src/index.ts" } });
    manifest("pkgs/web", "@x/web", ["@x/contract"], { exports: { ".": "./src/index.ts" } });
    manifest("pkgs/page", "@x/page", ["@x/web"], { exports: { "./page": "./dist/index.html" } });
    manifest("pkgs/daemon", "@x/daemon", ["@x/page", "@x/contract"], { exports: { ".": "./src/main.ts" } });
    write("pkgs/web/src/format.ts", "export const format = (n: number) => `${n}`;\n");
    write("pkgs/web/src/types.ts", "export type Row = { id: string };\n");
    write("pkgs/web/src/view.ts", 'import { format } from "./format.js";\nimport type { Row } from "./types";\nexport const view = (row: Row) => format(1);\n');
    write("pkgs/web/src/view.test.ts", 'import { view } from "./view.js";\n');
    write("pkgs/web/src/format.test.ts", 'import { format } from "./format";\n');
    write("pkgs/web/src/types.test.ts", 'import type { Row } from "./types.js";\n');
    write("pkgs/web/src/other.test.ts", 'import { expect } from "bun:test";\n');
    write("pkgs/web/bunfig.toml", "[test]\n");
    return root;
};

test("typecheck reaches every dependent, but not past a package that only ships a built asset", () => {
    const root = workspace();
    const graph = readWorkspaceGraph(root);
    const fromWeb = turnClosure(root, graph, ["pkgs/web/src/format.ts"]);
    assert.deepEqual([...fromWeb.typecheck].toSorted(), ["@x/page", "@x/web"]);
    const fromContract = turnClosure(root, graph, ["pkgs/contract/src/index.ts"]);
    assert.deepEqual([...fromContract.typecheck].toSorted(), ["@x/contract", "@x/daemon", "@x/page", "@x/web"]);
});

test("tests are the changed package's files whose value imports reach the change, and no dependent's", () => {
    const root = workspace();
    const graph = readWorkspaceGraph(root);
    const closure = turnClosure(root, graph, ["pkgs/web/src/format.ts"]);
    assert.deepEqual([...closure.tests], [["@x/web", ["src/format.test.ts", "src/view.test.ts"]]]);
});

test("a type-only import carries no behaviour, so it selects no test; the typecheck judges it", () => {
    const root = workspace();
    assert.deepEqual(relatedTests(join(root, "pkgs/web"), ["src/types.ts"]), []);
});

test("a changed test file runs itself, and a file every suite loads runs the whole suite", () => {
    const root = workspace();
    const graph = readWorkspaceGraph(root);
    assert.deepEqual([...turnClosure(root, graph, ["pkgs/web/src/other.test.ts"]).tests], [["@x/web", ["src/other.test.ts"]]]);
    assert.deepEqual([...turnClosure(root, graph, ["pkgs/web/bunfig.toml"]).tests], [["@x/web", "all"]]);
});

test("a root file every package reads typechecks them all and leaves their suites to the land", () => {
    const root = workspace();
    const graph = readWorkspaceGraph(root);
    const closure = turnClosure(root, graph, ["pnpm-workspace.yaml"]);
    assert.equal(closure.global, "pnpm-workspace.yaml");
    assert.equal(closure.typecheck.size, 4);
    assert.equal(closure.tests.size, 0);
});
