// Pins what counts as a timing or port hazard, since a rule that names harmless code teaches people to ignore it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { annotationsOf, codeOf, hazardsIn, scan, summaryOf } from "./timing-hazards.mjs";

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

test("the summary lists every occurrence and annotations stop at GitHub's ten a step", () => {
    const found = scan(["b.test.ts", "a.test.ts"], (path) => (path === "a.test.ts" ? "await Bun.sleep(500);\n".repeat(12) : "await Bun.sleep(200);"));
    assert.equal(found[0].path, "a.test.ts");
    const summary = summaryOf(found);
    assert.match(summary, /\| `real-sleep` \| 13 \| 2 \|/u);
    assert.match(summary, /`b\.test\.ts:1` real-sleep/u);
    const annotations = annotationsOf(found);
    assert.equal(annotations.length, 11);
    assert.match(annotations[0], /^::warning file=a\.test\.ts,line=1,title=timing hazard \(real-sleep\)::/u);
    assert.match(annotations[10], /3 more in the step summary/u);
    assert.match(summaryOf([]), /None found/u);
});

test("a file the checkout lacks is skipped rather than failing the scan", () => {
    assert.deepEqual(
        scan(["gone.test.ts"], () => {
            throw new Error("ENOENT");
        }),
        [],
    );
});
