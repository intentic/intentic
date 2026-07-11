import { afterAll, beforeAll, expect, test } from "vitest";
import { createEngine, type Engine } from "../index.js";
import { makeFixtureWorkspace } from "../testing.js";
import type { QueryRequest } from "../types.js";

let engine: Engine;
let cleanup: () => Promise<void>;

beforeAll(async () => {
    const fixture = await makeFixtureWorkspace();
    cleanup = fixture.cleanup;
    engine = createEngine({ root: fixture.root });
});
afterAll(() => cleanup());

const request = (verb: QueryRequest["verb"], query: string, scope: QueryRequest["scope"] = {}): QueryRequest => ({
    verb,
    query,
    scope,
    render: { budget: 1500 },
    options: {},
    echo: `${verb} ${query}`,
});

test("find warns about grep-dialect escapes proactively (in the header, not only on zero hits)", async () => {
    const outcome = await engine.run(request("find", "create\\|Widget"));
    expect(outcome.text).toContain("grep-style escapes");
    expect(outcome.text).toContain("alternation is a|b");
});

test("--lang matching zero files names the languages that ARE present, not a silent zero", async () => {
    const outcome = await engine.run(request("find", "createWidget", { langs: ["go"] }));
    expect(outcome.text).toContain("no go files in scope");
    expect(outcome.text).toMatch(/found: .*(ts|python)/);
});

test("def falls back to fuzzy symbol matches on a near-miss name", async () => {
    const outcome = await engine.run(request("def", "createWidg"));
    expect(outcome.text).toContain("no exact definition");
    expect(outcome.result.groups.some((group) => group.path.endsWith("widget.ts"))).toBe(true);
});

test("def on an exact symbol still returns the definition with a refs hint", async () => {
    const outcome = await engine.run(request("def", "createWidget"));
    expect(outcome.text).not.toContain("no exact definition");
    expect(outcome.text).toContain("refs: iq refs createWidget");
    expect(outcome.exitCode).toBe(0);
});

test("ask emits a compact candidate map so buried answers stay scannable", async () => {
    const outcome = await engine.run(request("ask", "how are widgets built for the registry?"));
    // Fixture has no embedding model → lexical fallback, but multiple groups still yield a candidate map.
    if (outcome.result.groups.length > 1) {
        expect(outcome.text).toContain("candidates:");
    }
});
