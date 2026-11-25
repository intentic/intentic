// Pins what counts as a timing or port hazard, since a rule that names harmless code teaches people to ignore it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { codeOf, hazardsIn } from "./timing-hazards.mjs";

const rules = (path, text) => hazardsIn(path, text).map(({ rule, line }) => `${rule}@${line}`);

test("a fixed port counts where the file binds it, and every line naming that port with it", () => {
    const text = [
        "const server = createServer();",
        "server.listen(4000);",
        "await fetch(`http://localhost:4000/x`);",
        "const other = `http://localhost:5173`;",
    ].join("\n");
    assert.deepEqual(rules("src/a.test.ts", text), ["fixed-port@2", "fixed-port@3"]);
    assert.deepEqual(rules("src/b.test.ts", "Bun.serve({ fetch, port: 8123 });"), ["fixed-port@1"]);
    assert.deepEqual(rules("src/c.test.ts", "const PORT = 4567;\napp.listen(PORT);"), ["fixed-port@2"]);
});

test("a port the file never binds, or binds as 0, is a fixture and not a hazard", () => {
    assert.deepEqual(rules("src/a.test.ts", 'expect(url("http://127.0.0.1:8787")).toBe("ws://127.0.0.1:8787/x");'), []);
    assert.deepEqual(rules("src/a.test.ts", "server.listen(0);\nconst { port } = server.address();"), []);
    assert.deepEqual(rules("src/a.test.ts", "forward: async () => ({ port: 9999 })"), []);
});

test("a real wait of 100 ms or more counts in a unit test and not in an integration one", () => {
    const text = [
        "await new Promise((resolve) => setTimeout(resolve, 400));",
        "await Bun.sleep(1_000);",
        "await new Promise((r) => setTimeout(r, 10));",
    ].join("\n");
    assert.deepEqual(rules("src/a.test.ts", text), ["real-sleep@1", "real-sleep@2"]);
    assert.deepEqual(rules("src/a.integration.test.ts", text), []);
});

test("fake timers make setTimeout waits fake, but never Bun.sleep", () => {
    const text = ["vi.useFakeTimers();", "await new Promise((resolve) => setTimeout(resolve, 400));", "await Bun.sleep(500);"].join("\n");
    assert.deepEqual(rules("src/a.test.ts", text), ["real-sleep@3"]);
});

test("an assertion on elapsed wall time counts, directly or through a variable", () => {
    const text = [
        "expect(Date.now() - started).toBeLessThan(5_000);",
        "const elapsed = performance.now() - t0;",
        "expect(elapsed).toBeGreaterThan(90);",
    ].join("\n");
    assert.deepEqual(rules("src/a.integration.test.ts", text), ["wall-clock-assertion@1", "wall-clock-assertion@3"]);
    assert.deepEqual(rules("src/a.test.ts", "expect(token({ expiresAt: Date.now() - 1 })).toBe(false);"), []);
    assert.deepEqual(rules("src/a.test.ts", "setSystemTime(new Date(0));\nexpect(Date.now() - started).toBeLessThan(5);"), []);
});

test("code quoted in a string, or commented out, is not code", () => {
    assert.equal(codeOf("const line = `await sleep(2000);`;"), "const line = ``;");
    assert.deepEqual(rules("src/a.test.ts", "expect(rank(`await sleep(2000); // replica`)).toBe(2);\n// await Bun.sleep(900);"), []);
});

test("a loop that sleeps between looks is a polling loop, anchored to the loop once", () => {
    const text = ["test(\"x\", async () => {", "    while (!ready()) {", "        await Bun.sleep(20);", "        await Bun.sleep(20);", "    }", "});"].join("\n");
    assert.deepEqual(rules("src/a.integration.test.ts", text), ["polling-loop@2"]);
    assert.deepEqual(rules("src/a.test.ts", "for (const item of items) {\n    await check(item);\n}"), []);
});

test("a module loaded inside a unit test's body counts, and not at module scope, in a hook or in an integration test", () => {
    const text = ["const top = await import(\"./a.js\");", "beforeAll(async () => {", "    await import(\"./b.js\");", "});", "it(\"loads\", async () => {", "    const { c } = await import(\"./c.js\");", "});"].join("\n");
    assert.deepEqual(rules("src/a.test.ts", text), ["in-test-import@6"]);
    assert.deepEqual(rules("src/a.integration.test.ts", text), []);
});

test("a per-test timeout counts unless a comment on its line or the one above says why", () => {
    const text = [
        "test(\"slow\", async () => {",
        "    await run();",
        "}, 20_000);",
        "test(\"explained\", async () => {",
        "    // builds the image first",
        "}, 20_000);",
        "test(\"inline\", async () => {",
        "}, 20_000); // cold cargo build",
        "test(\"option\", { timeout: 5_000 }, async () => {",
        "    await waitFor(() => done(), { timeout: 2_000 });",
        "});",
    ].join("\n");
    assert.deepEqual(rules("src/a.integration.test.ts", text), ["timeout-without-reason@3", "timeout-without-reason@9"]);
});
