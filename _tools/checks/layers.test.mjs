// Pins how a layer table places a module (lib/layers.mjs) and what the two boundary checks build from it
// (lib/daemon-graph.mjs, lib/editor-graph.mjs): an upward import is counted per edge in sites, a downward one is never
// a finding, and a cycle is looked for only among imports that stay in one layer.
import assert from "node:assert/strict";
import { test } from "node:test";
import { DAEMON_LAYERS } from "./lib/daemon-layers.mjs";
import { daemonGraphs, placeInDaemon } from "./lib/daemon-graph.mjs";
import { EDITOR_LAYERS } from "./lib/editor-layers.mjs";
import { editorLayering, placeInEditor } from "./lib/editor-graph.mjs";
import { directionOf, layering } from "./lib/layers.mjs";

test("the longest unit wins: a directory, a subdirectory, or a module named without its extension", () => {
    const { placeOf, top } = layering([
        { name: "low", units: ["lib", "shell/window", "views/registry"] },
        { name: "high", units: ["shell", "views"] },
    ]);
    assert.equal(top, 2);
    assert.equal(placeOf("lib/a.ts")?.layer, 0);
    assert.equal(placeOf("shell/window/useLayout.ts")?.unit, "shell/window");
    assert.equal(placeOf("shell/Shell.vue")?.unit, "shell");
    assert.equal(placeOf("views/registry.ts")?.unit, "views/registry");
    assert.equal(placeOf("views/registryAdmin.ts")?.unit, "views");
    assert.equal(placeOf("other/x.ts"), undefined);
});

test("an import's direction is read from the two layers alone", () => {
    assert.equal(directionOf(0, 1), "up");
    assert.equal(directionOf(1, 1), "same");
    assert.equal(directionOf(2, 0), "down");
});

test("no unit is placed twice in either table", () => {
    for (const table of [DAEMON_LAYERS, EDITOR_LAYERS]) {
        const units = table.flatMap(({ units: listed }) => listed);
        assert.deepEqual(
            units.filter((unit, index) => units.indexOf(unit) !== index),
            [],
        );
    }
});

test("a daemon route or testing module is the surface above every layer, a root file is in none, a runtime its own subsystem", () => {
    assert.equal(placeInDaemon("app.ts"), undefined);
    assert.equal(placeInDaemon("secrets/secrets.routes.ts")?.kind, "surface");
    assert.equal(placeInDaemon("system/resources/resources-slice.testing.ts")?.kind, "surface");
    assert.equal(placeInDaemon("runtimes/claude/claude-usage.ts")?.unit, "runtimes/claude");
    assert.equal(placeInDaemon("store/json-file.ts")?.layer, 0);
    assert.equal(placeInDaemon("brand-new/x.ts")?.layer, undefined);
});

test("the daemon's graph counts upward sites, ignores downward ones and finds cycles within one layer", () => {
    const src = "/src";
    const at = (path, text) => ({ file: `${src}/${path}`, text });
    const { upward, upwardSites, cycles, unplaced } = daemonGraphs(src, [
        // host -> foundation: down, never a finding.
        at("secrets/a.ts", 'import { x } from "../store/x.js";\nimport { c } from "../conversations/c.js";'),
        // host -> agent: up, twice from one file.
        at("secrets/b.ts", 'import { c } from "../conversations/c.js";\nimport type { T } from "../agent/t.js";'),
        // host <-> host: a same-layer cycle.
        at("auth/a.ts", 'import { g } from "../git/g.js";'),
        at("git/g.ts", 'import { a } from "../auth/a.js";'),
        // A non-route module importing a route module reaches up into the surface.
        at("needs/n.ts", 'import { upsert } from "../secrets/secrets.routes.js";'),
        // The surface may import anything.
        at("secrets/secrets.routes.ts", 'import { r } from "../bootstrap/r.js";'),
        at("brand-new/x.ts", 'import { a } from "../auth/a.js";'),
    ]);
    assert.deepEqual(Object.fromEntries(upward), { "secrets -> conversations": 2, "needs -> secrets surface": 1 });
    assert.deepEqual(upwardSites.get("secrets -> conversations"), ["secrets/a.ts:2", "secrets/b.ts:1"]);
    assert.deepEqual([...cycles.cycleEdges.keys()].sort(), ["auth -> git", "git -> auth"]);
    assert.deepEqual([...unplaced], ["brand-new"]);
});

test("the editor's features and workbench are shelves, one layer each but every subdirectory its own unit", () => {
    assert.equal(placeInEditor("main.ts"), undefined);
    assert.equal(placeInEditor("features/chat/panel/ChatPane.vue")?.unit, "features/chat");
    assert.equal(placeInEditor("workbench/window/useLayout.ts")?.unit, "workbench/window");
    assert.equal(placeInEditor("shell/window/PoppablePanels.vue")?.unit, "shell");
    assert.equal(placeInEditor("shell/ShellDesktop.vue")?.unit, "shell");
    assert.ok((placeInEditor("client/sandbox/useSandbox.ts")?.layer ?? 0) < (placeInEditor("components/X.vue")?.layer ?? 0));
    assert.ok((placeInEditor("workbench/window/useLayout.ts")?.layer ?? 0) < (placeInEditor("features/chat/x.ts")?.layer ?? 0));
    assert.ok((placeInEditor("features/chat/x.ts")?.layer ?? 0) < (placeInEditor("shell/ShellDesktop.vue")?.layer ?? 0));

    const { upward, cycles } = editorLayering(
        new Map([
            ["lib/useApi.ts", 'import { auth } from "../features/auth/auth";'],
            ["features/auth/auth.ts", 'import { layout } from "../../workbench/window/useLayout";\nimport { b } from "../billing/b";'],
            ["features/billing/b.ts", 'import { auth } from "../auth/auth";'],
            ["workbench/window/useLayout.ts", "export const layout = 1;"],
            ["shell/ShellDesktop.vue", '<script setup lang="ts">\nimport { auth } from "../features/auth/auth";\n</script>'],
        ]),
    );
    assert.deepEqual(Object.fromEntries(upward), { "lib -> features/auth": 1 });
    assert.deepEqual([...cycles.cycleEdges.keys()].sort(), ["features/auth -> features/billing", "features/billing -> features/auth"]);
});
