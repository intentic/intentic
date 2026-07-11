import { afterAll, beforeAll, expect, test } from "vitest";
import { createEngine, type Engine } from "../index.js";
import { makeFixtureWorkspace } from "../testing.js";
import type { QueryRequest } from "../types.js";

let root: string;
let cleanup: () => Promise<void>;
let engine: Engine;

beforeAll(async () => {
    ({ root, cleanup } = await makeFixtureWorkspace());
    engine = createEngine({ root });
});
afterAll(() => cleanup());

const request = (partial: Partial<QueryRequest> & { verb: QueryRequest["verb"]; query: string }): QueryRequest => ({
    scope: {},
    render: { budget: 1500 },
    options: {},
    echo: `${partial.verb} "${partial.query}"`,
    ...partial,
});

test("def: finds the definition with signature and a refs hint", async () => {
    const outcome = await engine.run(request({ verb: "def", query: "createWidget" }));
    expect(outcome.exitCode).toBe(0);
    expect(outcome.result.groups[0]?.path).toBe("repositories/alpha/src/widget.ts");
    expect(outcome.result.groups[0]?.hits[0]?.text).toContain("export const createWidget");
    expect(outcome.text).toContain("hint: refs: iq refs createWidget");
});

test("refs: classifies imports vs calls and drops the definition line", async () => {
    const all = await engine.run(request({ verb: "refs", query: "createWidget" }));
    expect(all.exitCode).toBe(0);
    // The def line itself (widget.ts:6) is not a ref.
    const widgetGroup = all.result.groups.find((group) => group.path === "repositories/alpha/src/widget.ts");
    expect(widgetGroup).toBeUndefined();

    const imports = await engine.run(request({ verb: "refs", query: "createWidget", options: { refKind: "import" } }));
    expect(imports.result.groups.flatMap((group) => group.hits).every((hit) => hit.tags.some((tag) => tag.kind === "import"))).toBe(true);

    const calls = await engine.run(request({ verb: "refs", query: "createWidget", options: { refKind: "call" } }));
    expect(calls.result.total).toBeGreaterThanOrEqual(2); // registry.ts twice + spec
});

test("sym: fuzzy name search with kind filter", async () => {
    const outcome = await engine.run(request({ verb: "sym", query: "widget" }));
    expect(outcome.exitCode).toBe(0);
    expect(outcome.result.groups.some((group) => group.hits.some((hit) => hit.text.includes("createWidget")))).toBe(true);

    const types = await engine.run(request({ verb: "sym", query: "Widget", options: { symKind: "type" } }));
    expect(types.result.groups.flatMap((group) => group.hits).every((hit) => hit.text.startsWith("type"))).toBe(true);

    const glob = await engine.run(request({ verb: "sym", query: "create*" }));
    expect(glob.result.total).toBeGreaterThanOrEqual(1);
});

test("ast: structural pattern with metavariables", async () => {
    const outcome = await engine.run(request({ verb: "ast", query: "createWidget($A)", options: { astLang: "ts" } }));
    expect(outcome.exitCode).toBe(0);
    // Calls only — the parenthesized pattern does not match the def's arrow or bare imports.
    expect(outcome.result.groups.map((group) => group.path).toSorted()).toEqual([
        "repositories/alpha/src/registry.ts",
        "repositories/alpha/src/widget.spec.ts",
    ]);
    await expect(engine.run(request({ verb: "ast", query: "x", options: {} }))).rejects.toThrow("--lang is required");
});

test("outline: signatures with doc first-lines, anchored to real lines", async () => {
    const outcome = await engine.run(request({ verb: "outline", query: "repositories/alpha/src/widget.ts" }));
    expect(outcome.exitCode).toBe(0);
    const texts = outcome.result.groups[0]!.hits.map((hit) => hit.text);
    expect(texts.some((text) => text.includes("createWidget") && text.includes("// Builds one widget."))).toBe(true);
    expect(outcome.result.groups[0]!.hits.every((hit) => hit.line >= 1)).toBe(true);
});

test("context: returns the enclosing region of an anchor and grows with -C", async () => {
    const outcome = await engine.run(request({ verb: "context", query: "repositories/alpha/src/registry.ts:3" }));
    expect(outcome.exitCode).toBe(0);
    expect(outcome.text).toContain("defaultWidgets");

    const grown = await engine.run(
        request({ verb: "context", query: "repositories/alpha/src/registry.ts:3", render: { budget: 1500, contextLines: 2 } }),
    );
    expect(grown.result.groups[0]!.hits.length).toBeGreaterThan(outcome.result.groups[0]!.hits.length);

    await expect(engine.run(request({ verb: "context", query: "no-line-anchor" }))).rejects.toThrow("path:line");
    await expect(engine.run(request({ verb: "outline", query: "../escape.ts" }))).rejects.toThrow("denied or outside");
    // No security floor: a former-secret file resolves and reads through like any other contained file.
    await expect(engine.run(request({ verb: "context", query: ".env:1" }))).resolves.toMatchObject({ exitCode: 0 });
});
