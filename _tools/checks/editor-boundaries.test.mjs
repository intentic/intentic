// Pins what editor-boundaries reads as an import (lib/imports.mjs, lib/editor-graph.mjs) and which imports make a cycle:
// a static value import between modules, and any value import between subsystems.
import assert from "node:assert/strict";
import { test } from "node:test";
import { editorGraphs, resolveIn, scriptOf, subsystemOf } from "./lib/editor-graph.mjs";
import { importsOf } from "./lib/imports.mjs";

const specifiers = (text) => importsOf(text).map(({ specifier, typeOnly, dynamic, line }) => ({ specifier, typeOnly, dynamic, line }));

test("a call's specifier may be a template or follow a comment; a template with a substitution names no module", () => {
    const text = [
        "const a = () => import(`./a`);",
        'const b = () => import(/* @vite-ignore */ "./b");',
        "const c = (locale) => import(`./locales/${locale}.json`);",
        'const d = () => import("./d", { with: { type: "json" } });',
        'import type { E } from "./e";',
        'import { type F, g } from "./f";',
    ].join("\n");
    assert.deepEqual(specifiers(text), [
        { specifier: "./e", typeOnly: true, dynamic: false, line: 5 },
        { specifier: "./f", typeOnly: false, dynamic: false, line: 6 },
        { specifier: "./a", typeOnly: false, dynamic: true, line: 1 },
        { specifier: "./b", typeOnly: false, dynamic: true, line: 2 },
        { specifier: "./d", typeOnly: false, dynamic: true, line: 4 },
    ]);
});

test("a Vue component is read from its script blocks, at the file's own lines", () => {
    const component = [
        '<template>\n  <p>import x from "./NotAnImport"</p>\n</template>',
        '<script setup lang="ts">',
        'import { p } from "../lib/p";',
        "</script>",
    ].join("\n");
    assert.deepEqual(specifiers(scriptOf("components/C.vue", component)), [{ specifier: "../lib/p", typeOnly: false, dynamic: false, line: 5 }]);
});

test("a relative specifier resolves as the bundler does here, and a package or an asset to nothing", () => {
    const modules = new Map([
        ["lib/x.ts", ""],
        ["lib/dir/index.ts", ""],
        ["lib/View.vue", ""],
    ]);
    assert.equal(resolveIn(modules, "app/a.ts", "../lib/x"), "lib/x.ts");
    assert.equal(resolveIn(modules, "app/a.ts", "../lib/x.js"), "lib/x.ts");
    assert.equal(resolveIn(modules, "app/a.ts", "../lib/dir"), "lib/dir/index.ts");
    assert.equal(resolveIn(modules, "app/a.ts", "../lib/View.vue"), "lib/View.vue");
    assert.equal(resolveIn(modules, "app/a.ts", "../lib/x.css"), undefined);
    assert.equal(resolveIn(modules, "app/a.ts", "@intentic/ui"), undefined);
});

test("each top-level directory is a subsystem, each feature its own, and a root file none", () => {
    assert.equal(subsystemOf("shell/window/floating.ts"), "shell");
    assert.equal(subsystemOf("features/chat/panel/ChatPane.vue"), "features/chat");
    assert.equal(subsystemOf("main.ts"), undefined);
});

test("a static value cycle between modules is one; a dynamic or type-only way back is not", () => {
    const { files } = editorGraphs(
        new Map([
            ["lib/p.ts", 'import { q } from "./q";'],
            ["lib/q.ts", 'export { p } from "./p";'],
            ["features/auth/useAuth.ts", 'import { track } from "../../app/analytics";'],
            ["app/analytics.ts", "export const track = async () => (await import(`../features/auth/useAuth`)).user;"],
            ["app/types.ts", 'import type { User } from "../features/auth/user";'],
            ["features/auth/user.ts", 'import { kinds } from "../../app/types";'],
        ]),
    );
    assert.deepEqual(files.components, [["lib/q.ts", "lib/p.ts"]]);
    assert.deepEqual([...files.cycleEdges.keys()].sort(), ["lib/p.ts -> lib/q.ts", "lib/q.ts -> lib/p.ts"]);
    assert.equal(
        files.closes(files.cycleEdges.get("lib/p.ts -> lib/q.ts")),
        "lib/p.ts -> lib/q.ts closes lib/p.ts -> lib/q.ts -> lib/p.ts: imported at lib/p.ts:1; the way back is lib/q.ts -> lib/p.ts (lib/q.ts:1)",
    );
});

test("between subsystems a dynamic import couples as a static one does, a type-only one does not, and a root file is outside", () => {
    const { subsystems } = editorGraphs(
        new Map([
            ["features/auth/useAuth.ts", 'import { track } from "../../app/analytics";'],
            ["app/analytics.ts", "export const track = async () => (await import(`../features/auth/useAuth`)).user;"],
            ["app/theme.ts", 'import type { Skin } from "../skins/skin";'],
            ["skins/skin.ts", 'import { mode } from "../app/theme";'],
            ["main.ts", 'import { track } from "./app/analytics";'],
            ["app/boot.ts", 'import "../main";'],
        ]),
    );
    assert.deepEqual([...subsystems.cycleEdges.keys()].sort(), ["app -> features/auth", "features/auth -> app"]);
    assert.deepEqual(subsystems.nodes, ["app", "features/auth", "skins"]);
});
