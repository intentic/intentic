// Pins what sandbox-scope reads as speaking of the active sandbox without saying so: its id read anywhere but an import,
// a sandboxRpc call with no `at` in its context, an rpcQuery with no `at`; and never a comment quoting the shape, a
// call aimed elsewhere, or a site that says why it must stay.
import assert from "node:assert/strict";
import { test } from "node:test";
import { balanced, sandboxScopeCalls } from "./lib/sandbox-scope-calls.mjs";

const lines = (text) => sandboxScopeCalls(text).map(({ line }) => line);

test("the active id read is counted once per line, in code and template alike, and never in an import", () => {
    assert.deepEqual(
        lines(
            [
                `import { activeSandboxId } from "../app/storage/activeSandbox";`,
                `import {`,
                `    activeSandboxId,`,
                `} from "./x";`,
                `const id = activeSandboxId.value ?? activeSandboxId.value;`,
                `<span v-if="sandbox.activeSandboxId.value === box.id" />`,
            ].join("\n"),
        ),
        [5, 6],
    );
});

test("a sandboxRpc call counts unless its context names `at`, written out or as shorthand", () => {
    assert.deepEqual(
        lines(
            [
                "await sandboxRpc.agents.list();",
                "await sandboxRpc.git.log({ repo }, { signal });",
                "await sandboxRpc.agents.attentionMine(undefined, { context: { at: id, background: true } });",
                "await sandboxRpc.agents.attentionMine(undefined, { context: { background: true, at } });",
                "await sandboxRpc.files.read(",
                "    { path: `a`, at: 3 },",
                "    { context: { gitView } },",
                ");",
                "await sandboxRpc.agents.list(undefined, { context: { at, gitView } });",
            ].join("\n"),
        ),
        [1, 2, 5],
    );
});

test("an rpcQuery counts unless its options name `at`", () => {
    assert.deepEqual(
        lines(
            [
                "useSandboxQuery(rpcQuery(`agents.list`));",
                "useSandboxQuery(rpcQuery(`agents.get`, () => ({ id: id.value }), { unpersisted: true }));",
                "useSandboxQuery(rpcQuery(`agents.list`, undefined, { at: () => box.id }), () => box.id);",
                "useSandboxQuery(rpcQuery(`agents.list`, undefined, { at }));",
                "useSandboxQuery(scope.query(`agents.list`), scope.at);",
            ].join("\n"),
        ),
        [1, 2],
    );
});

test("only an rpcQuery's options aim it, and type arguments or optional chaining hide no call", () => {
    assert.deepEqual(
        lines(
            [
                "useSandboxQuery(rpcQuery(`git.show`, () => ({ repo, at: sha })));",
                "useSandboxQuery(rpcQuery(`git.show`, () => ({ repo, at: sha }), { at: () => box.id }));",
                "useSandboxQuery(rpcQuery<`agents.list`>(`agents.list`));",
                "await sandboxRpc.agents?.list();",
                "await sandboxRpc?.agents.list(undefined, { context: { at } });",
            ].join("\n"),
        ),
        [1, 3, 4],
    );
});

test("a comment quoting the shape is not a site, and a site that says why is excused only with a reason", () => {
    assert.deepEqual(lines("// activeSandboxId and sandboxRpc.agents.list()\n/*\n * rpcQuery(`agents.list`)\n */\n<!-- activeSandboxId -->"), []);
    assert.deepEqual(lines("// allow(sandbox-scope): the switch itself names where the window is\nconst id = activeSandboxId.value;"), []);
    assert.deepEqual(lines("await sandboxRpc.agents.list(); // allow(sandbox-scope): only ever the active one"), []);
    assert.deepEqual(lines("// allow(sandbox-scope):\nawait sandboxRpc.agents.list();"), [2]);
});

test("arguments are read to their closing bracket past strings that hold brackets", () => {
    assert.equal(balanced("f(`)`, { a: [1] })", 1), "`)`, { a: [1] }");
    assert.equal(balanced("f(a", 1), undefined);
});
