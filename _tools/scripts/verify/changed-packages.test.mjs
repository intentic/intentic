// Pins what quick typechecks: the packages holding a changed file, by the workspace's own membership, and never every
// package because a root file changed beside them.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ownersOf, readWorkspaceGraph } from "../../checks/lib/workspace-graph.mjs";
import { repoRoot } from "../../constants/src/node.mjs";
import { filtersFor } from "./changed-packages.mjs";

const root = repoRoot(import.meta.url);
const graph = readWorkspaceGraph(root);
const nameAt = (dir) => [...graph.packages.values()].find((pkg) => pkg.dir === dir)?.name;

test("a root file beside a package's own file names that package alone", () => {
    const web = nameAt("_editor/web");
    assert.ok(web);
    assert.deepEqual([...ownersOf(graph, ["pnpm-lock.yaml", "package.json", "turbo.json", "_editor/web/src/main.ts"])], [web]);
});

test("root files alone name no package", () => {
    assert.equal(ownersOf(graph, ["pnpm-lock.yaml", "package.json", "README.md", ".github/workflows/ci.yml"]).size, 0);
});

test("a path is owned by the deepest member containing it, once however many of its files changed", () => {
    const owners = ownersOf(graph, ["_editor/web/src/a.ts", "_editor/web/src/b.vue", "_editor/web/package.json"]);
    assert.equal(owners.size, 1);
});

test("filters come out one per package, sorted, in turbo's spelling", () => {
    assert.deepEqual(filtersFor(new Set(["@intentic/web", "@intentic/api"])), ["--filter=@intentic/api", "--filter=@intentic/web"]);
    assert.deepEqual(filtersFor(new Set()), []);
});
