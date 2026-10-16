import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { BARREL, rewriteFile, rewriteSource } from "./subpath-imports.mjs";

// A barrel of four modules and two names index.ts defines itself.
const MODULES = new Map([
    ["AgentSchema", "schemas/agents"],
    ["Agent", "schemas/agents"],
    ["agentStalled", "models/agent-state"],
    ["isZone", "time/zone"],
    ["RAW_ROUTES", "protocol/raw/raw-routes"],
    ["sandboxContract", null],
    ["SANDBOX_ROUTES", null],
]);
const SOURCE = join(fileURLToPath(new URL("..", import.meta.url)), "src");

// Fixtures name the barrel `@barrel`, which stands for it on the way in and out, so no checker reads them as real imports.
const named = (result) => ({ ...result, text: result.text.replaceAll(BARREL, "@barrel") });
const rewrite = (text, file = "/repo/app/file.ts") => named(rewriteSource(text.replaceAll("@barrel", BARREL), MODULES, file));

test("splits a named import per declaring module, keeping type modifiers, aliases and index's own names", () => {
    const { text, stats } = rewrite(`import { AgentSchema, type Agent, isZone as zoned, sandboxContract } from "@barrel";\nuse();\n`);
    assert.equal(
        text,
        `import { AgentSchema, type Agent } from "@barrel/schemas/agents";\n` +
            `import { isZone as zoned } from "@barrel/time/zone";\n` +
            `import { sandboxContract } from "@barrel";\nuse();\n`,
    );
    assert.deepEqual(stats, { declarations: 1, splits: 2, moved: 3, mocks: 0, dynamic: 0, namespaces: 0, generated: 0 });
});

test("writes a group of names that are all `type` as an `import type`", () => {
    const { text } = rewrite(`import { type Agent, isZone } from "@barrel";\n`);
    assert.equal(text, `import type { Agent } from "@barrel/schemas/agents";\nimport { isZone } from "@barrel/time/zone";\n`);
});

test("keeps `import type`, backticks and re-exports in their own form", () => {
    const { text } = rewrite("import type { Agent } from `@barrel`;\nexport { isZone, SANDBOX_ROUTES } from `@barrel`;\n");
    assert.equal(
        text,
        "import type { Agent } from `@barrel/schemas/agents`;\n" +
            "export { isZone } from `@barrel/time/zone`;\nexport { SANDBOX_ROUTES } from `@barrel`;\n",
    );
});

test("joins an import of the same module already in the file, and drops the emptied line", () => {
    const { text } = rewrite(`import { Agent } from "@barrel/schemas/agents";\nimport { AgentSchema } from "@barrel";\nrun();\n`);
    assert.equal(text, `import { Agent, AgentSchema } from "@barrel/schemas/agents";\nrun();\n`);
});

test("breaks a declaration past the print width one name a line", () => {
    const names = ["AgentSchema", ...Array.from({ length: 20 }, (_, at) => `Agent as A${at}`)];
    const { text } = rewrite(`import { ${names.join(", ")} } from "@barrel";\n`);
    assert.equal(text, `import {\n${names.map((name) => `    ${name},`).join("\n")}\n} from "@barrel/schemas/agents";\n`);
});

test("moves a dynamic import whose names all come from one module, and names one that spans two", () => {
    const one = rewrite(`const { AgentSchema, Agent: Named } = await import("@barrel");\n`);
    assert.equal(one.text, `const { AgentSchema, Agent: Named } = await import("@barrel/schemas/agents");\n`);
    const two = rewrite(`const { AgentSchema, isZone } = await import("@barrel");\n`);
    assert.equal(two.changed, false);
    assert.deepEqual(two.humans, [{ line: 1, why: "dynamic import of AgentSchema, isZone, from more than one module" }]);
});

test("moves a mock to the module that now serves its names, a spread of the namespace included", () => {
    const keys = rewrite("jest.mock(`@barrel`, () => ({ isZone: () => true }));\n");
    assert.equal(keys.text, "jest.mock(`@barrel/time/zone`, () => ({ isZone: () => true }));\n");
    const spread = rewrite(
        `import * as real from "@barrel";\nconst kept = real.agentStalled;\n` + `jest.mock("@barrel", () => ({ ...real, agentStalled: kept }));\n`,
    );
    assert.equal(
        spread.text,
        `import * as real from "@barrel/models/agent-state";\nconst kept = real.agentStalled;\n` +
            `jest.mock("@barrel/models/agent-state", () => ({ ...real, agentStalled: kept }));\n`,
    );
    assert.equal(spread.stats.mocks, 1);
    const spans = rewrite(`mock.module("@barrel", () => ({ isZone: 1, AgentSchema: 2 }));\n`);
    assert.deepEqual(spans.humans, [{ line: 1, why: "mock of the barrel replacing 2 names from more than one module; split it per module" }]);
});

test("rewrites a component's script blocks, reporting lines of the whole file", () => {
    const component = `<template><p /></template>\n<script setup lang="ts">\nimport { isZone } from "@barrel";\nimport * as all from "@barrel";\nuse(all);\n</script>\n`;
    const { text, humans } = named(rewriteFile("/repo/app/View.vue", component.replaceAll("@barrel", BARREL), MODULES));
    assert.match(text, /import \{ isZone \} from "@barrel\/time\/zone";/);
    assert.deepEqual(humans, [{ line: 4, why: "namespace import `all` of the barrel is used whole; name the modules it reads" }]);
});

test("inside the package, rewrites a relative import of index.ts to the module's relative path", () => {
    const { text } = rewriteSource(
        `import { RAW_ROUTES, SANDBOX_ROUTES } from "../index.js";\n`,
        MODULES,
        join(SOURCE, "protocol", "routes.test.ts"),
    );
    assert.equal(text, `import { RAW_ROUTES } from "./raw/raw-routes.js";\nimport { SANDBOX_ROUTES } from "../index.js";\n`);
});

test("rewrites a generator's template of an import line, and names one it cannot", () => {
    const { text } = rewrite(`const lines = ['import type { Agent } from "@barrel";'];\n`);
    assert.equal(text, `const lines = ['import type { Agent } from "@barrel/schemas/agents";'];\n`);
    const single = rewrite(`const line = "import { isZone } from '@barrel';";\n`);
    assert.equal(single.text, `const line = "import { isZone } from '@barrel/time/zone';";\n`);
    const spans = rewrite(`const line = 'import { isZone, AgentSchema } from "@barrel";';\n`);
    assert.deepEqual(spans.humans, [{ line: 1, why: "a string writing an import of the barrel, which cannot be rewritten in place" }]);
});

test("a second run changes nothing", () => {
    const first = rewrite(`import { AgentSchema, isZone, sandboxContract } from "@barrel";\n`);
    const second = rewrite(first.text);
    assert.equal(second.changed, false);
    assert.equal(second.text, first.text);
});
