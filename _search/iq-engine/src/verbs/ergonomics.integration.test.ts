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

test("find recovers grep-dialect escapes by rerunning with them stripped, and says so", async () => {
    const outcome = await engine.run(request("find", "create\\|Widget"));
    expect(outcome.text).toContain("grep-style escapes rewritten to rust regex, matched: create|Widget");
    expect(outcome.result.groups.some((group) => group.path.endsWith("widget.ts"))).toBe(true);
    expect(outcome.exitCode).toBe(0);
});

test("find recovers a pattern rust regex rejects by rerunning it literally", async () => {
    const outcome = await engine.run(request("find", "createWidget({"));
    expect(outcome.text).toContain("ran as literal text");
    expect(outcome.exitCode).toBe(1);
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

test("the capsule leads with the answer anchor, before any code", async () => {
    const outcome = await engine.run(request("q", "how are widgets built for the registry?"));
    const lines = outcome.text.split("\n");
    expect(lines[0]).toContain("iq: ");
    expect(lines[1]).toMatch(/^answer: \S+:\d+/);
    // Everything the agent needs to decide its next move precedes the first code line.
    expect(lines.findIndex((line) => line.startsWith("════"))).toBeGreaterThan(1);
});

test("candidates name the ranked paths that did not fit, above the code", async () => {
    const outcome = await engine.run({ ...request("q", "widget"), render: { budget: 200 } });
    if (!outcome.result.truncated) {
        return;
    }
    const lines = outcome.text.split("\n");
    const candidates = lines.findIndex((line) => line.startsWith("candidates:"));
    const more = lines.findIndex((line) => line.startsWith("more:"));
    expect(more).toBeGreaterThan(0);
    expect(lines[more]).toContain("--after ");
    const firstCode = lines.findIndex((line) => line.startsWith("════"));
    if (candidates >= 0 && firstCode >= 0) {
        expect(candidates).toBeLessThan(firstCode);
    }
});

test("the structured result names the same candidates the text does, and never a shown group", async () => {
    // A JSON caller (the web search route) used to get strictly less than the terminal: the ranked map of what
    // placed but did not fit was printed and then dropped from the result, leaving paging as the only way to it.
    const outcome = await engine.run({ ...request("q", "widget"), render: { budget: 200 } });
    const printed = outcome.text
        .split("\n")
        .find((line) => line.startsWith("candidates: "))
        ?.slice("candidates: ".length)
        .split(" · ");
    expect(outcome.result.candidates).toEqual(printed);
    const shown = new Set(outcome.result.groups.map((group) => group.path));
    for (const candidate of outcome.result.candidates ?? []) {
        expect(shown.has(candidate)).toBe(false);
    }
});
