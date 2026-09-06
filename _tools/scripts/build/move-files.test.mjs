/* The rewriting rules of move-files.mjs, drilled on the four styles this repository actually writes. Run by
 * `pnpm verify` (`node --test _tools/scripts`) and by hand: `node --test _tools/scripts/build/`.
 *
 * These are the pure halves — resolution, specifier style, manifest targets — because they are where a
 * codemod is wrong in a way a type-check cannot see: a specifier that still RESOLVES but now points at the
 * wrong file of two with the same name. The `git mv` half is exercised by using the tool. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { expandMoves, planEdits, resolveRelative, rewriteManifest, rewriteSpecifiers, specifierFor } from "./move-files.mjs";

const tracked = new Set([
    "_sandbox/sandbox/src/agent/agent.ts",
    "_sandbox/sandbox/src/agent/turn-plan.ts",
    "_sandbox/sandbox/src/agent/prompt/system-prompt.ts",
    "_sandbox/sandbox/src/composition.ts",
    "_sandbox/sandbox/package.json",
    "_editor/web/src/chat/ChatArea.vue",
    "_editor/web/src/composables/chat/useChat.ts",
    "_editor/web/src/lib/index.ts",
]);

test("a directory move means every tracked file under it", () => {
    const moves = expandMoves([{ from: "_sandbox/sandbox/src/agent", to: "_sandbox/sandbox/src/turn" }], tracked);
    assert.deepEqual(
        moves.map(({ to }) => to).toSorted(),
        ["_sandbox/sandbox/src/turn/agent.ts", "_sandbox/sandbox/src/turn/prompt/system-prompt.ts", "_sandbox/sandbox/src/turn/turn-plan.ts"],
    );
});

test("a specifier written with the emitted extension resolves to its source", () => {
    assert.equal(resolveRelative("_sandbox/sandbox/src/agent/agent.ts", "./turn-plan.js", tracked), "_sandbox/sandbox/src/agent/turn-plan.ts");
    assert.equal(resolveRelative("_sandbox/sandbox/src/agent/agent.ts", "../composition.js", tracked), "_sandbox/sandbox/src/composition.ts");
});

test("an extensionless specifier resolves through the file and through a directory index", () => {
    assert.equal(resolveRelative("_editor/web/src/chat/ChatArea.vue", "../composables/chat/useChat", tracked), "_editor/web/src/composables/chat/useChat.ts");
    assert.equal(resolveRelative("_editor/web/src/chat/ChatArea.vue", "../lib", tracked), "_editor/web/src/lib/index.ts");
});

test("each style survives the move it is written in", () => {
    // the daemon: keeps the emitted extension
    assert.equal(specifierFor("_sandbox/sandbox/src/agent/run/agent.ts", "_sandbox/sandbox/src/agent/turn-plan.ts", "./turn-plan.js"), "../turn-plan.js");
    // the web: keeps no extension
    assert.equal(specifierFor("_editor/web/src/features/chat/ChatArea.vue", "_editor/web/src/composables/chat/useChat.ts", "../composables/chat/useChat"), "../../composables/chat/useChat");
    // a directory import stays a directory import
    assert.equal(specifierFor("_editor/web/src/features/chat/ChatArea.vue", "_editor/web/src/lib/index.ts", "../lib"), "../../lib");
    // a .vue target keeps its real extension
    assert.equal(specifierFor("_editor/web/src/pages/Home.vue", "_editor/web/src/features/chat/ChatArea.vue", "../chat/ChatArea.vue"), "../features/chat/ChatArea.vue");
    // a sibling is written as one, never as a bare name
    assert.equal(specifierFor("_sandbox/sandbox/src/agent/run/agent.ts", "_sandbox/sandbox/src/agent/run/turn-plan.ts", "./turn-plan.js"), "./turn-plan.js");
    // plumbing that runs unbuilt imports the .mjs that EXISTS, and must not be re-pointed at an emitted name
    assert.equal(specifierFor("_tools/scripts/verify/verify.mjs", "_tools/scripts/lib/steps.mjs", "../lib/steps.mjs"), "../lib/steps.mjs");
    assert.equal(specifierFor("_tools/scripts/verify/verify.mjs", "_tools/constants/src/node.mjs", "../../constants/src/node.mjs"), "../../constants/src/node.mjs");
    // a dot inside the filename is not an extension: `environment.default` keeps its extensionless spelling
    assert.equal(
        specifierFor("_editor/web/src/app/environments/environment.local.ts", "_editor/web/src/app/environments/environment.default.ts", "./environment.default"),
        "./environment.default",
    );
});

test("a specifier neither end of which moved is left alone, roundabout or not", () => {
    const source = `import { x } from "../chat/useChat";\nimport { y } from "./useChat";`;
    const { text, changes } = rewriteSpecifiers(source, "_editor/web/src/composables/chat/other.ts", (path) => path, new Set([...tracked, "_editor/web/src/composables/chat/other.ts"]));
    assert.deepEqual(changes, [], "normalising a path the move did not touch is a diff nobody asked for");
    assert.equal(text, source);
});

test("an import of a moved file is re-aimed, and an untouched one is left byte-identical", () => {
    const source = [
        `import { plan } from "./turn-plan.js";`,
        `import { services } from "../composition.js";`,
        `vi.mock("./turn-plan.js", () => ({}));`,
        `const late = await import("./turn-plan.js");`,
        `const label = "./turn-plan.js is not an import";`,
    ].join("\n");
    const finalOf = (path) => (path === "_sandbox/sandbox/src/agent/turn-plan.ts" ? "_sandbox/sandbox/src/agent/run/turn-plan.ts" : path);
    const { text, changes } = rewriteSpecifiers(source, "_sandbox/sandbox/src/agent/agent.ts", finalOf, tracked);
    assert.equal(changes.length, 3, "the three import contexts, and not the string that merely looks like one");
    assert.match(text, /from "\.\/run\/turn-plan\.js"/);
    assert.match(text, /vi\.mock\("\.\/run\/turn-plan\.js"/);
    assert.match(text, /await import\("\.\/run\/turn-plan\.js"\)/);
    assert.match(text, /from "\.\.\/composition\.js"/, "a specifier whose target did not move is untouched");
    assert.match(text, /const label = "\.\/turn-plan\.js is not an import"/, "a string in no import context is not a specifier");
});

test("a module named twice in one call — the type argument and the specifier — moves in both places", () => {
    const source = `const { plan } = await vi.importActual<typeof import("./turn-plan.js")>("./turn-plan.js");`;
    const finalOf = (path) => (path === "_sandbox/sandbox/src/agent/turn-plan.ts" ? "_sandbox/sandbox/src/agent/run/turn-plan.ts" : path);
    const { text, changes } = rewriteSpecifiers(source, "_sandbox/sandbox/src/agent/agent.test.ts", finalOf, tracked);
    assert.equal(changes.length, 2, "the type argument and the call's own string are both the module's name");
    assert.equal(text, `const { plan } = await vi.importActual<typeof import("./run/turn-plan.js")>("./run/turn-plan.js");`);
});

test("the moved file's own imports follow it to its new depth", () => {
    const source = `import { services } from "../composition.js";`;
    const finalOf = (path) => (path === "_sandbox/sandbox/src/agent/agent.ts" ? "_sandbox/sandbox/src/agent/run/agent.ts" : path);
    const { text } = rewriteSpecifiers(source, "_sandbox/sandbox/src/agent/agent.ts", finalOf, tracked);
    assert.match(text, /from "\.\.\/\.\.\/composition\.js"/);
});

test("a subpath export keeps its key and moves its target, in source and in dist", () => {
    const manifest = JSON.stringify(
        {
            exports: {
                "./prompt": { types: "./dist/agent/system-prompt.d.ts", import: { "@intentic/src": "./src/agent/system-prompt.ts", default: "./dist/agent/system-prompt.js" } },
            },
        },
        null,
        4,
    );
    const finalOf = (path) => (path === "_sandbox/sandbox/src/agent/system-prompt.ts" ? "_sandbox/sandbox/src/prompt/system-prompt.ts" : path);
    const withSource = new Set([...tracked, "_sandbox/sandbox/src/agent/system-prompt.ts"]);
    const { text, changes } = rewriteManifest(manifest, "_sandbox/sandbox", finalOf, withSource);
    assert.equal(changes.length, 3);
    assert.match(text, /"\.\/src\/prompt\/system-prompt\.ts"/);
    assert.match(text, /"\.\/dist\/prompt\/system-prompt\.js"/);
    assert.match(text, /"\.\/dist\/prompt\/system-prompt\.d\.ts"/);
    assert.match(text, /"\.\/prompt":/, "the specifier a consumer writes is not a path and does not move");
});

test("planEdits reads only what can carry a specifier", () => {
    const edits = planEdits(process.cwd(), new Set(["README.md", "docs/notes.txt"]), (path) => path);
    assert.deepEqual(edits, [], "prose has no module specifiers, so it is never opened");
});
