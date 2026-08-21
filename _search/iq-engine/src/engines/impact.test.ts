import { expect, test } from "vitest";
import { impactOf } from "./impact.js";
import type { ImportGraph } from "./import-graph.js";

// app → page → widget → util, plus a stray test file importing widget, and a cycle between a/b.
const graphOf = (edges: readonly (readonly [string, string])[], extraPaths: readonly string[] = []): ImportGraph => {
    const paths = [...new Set([...edges.flat(), ...extraPaths])].toSorted();
    const idByPath = new Map(paths.map((path, index) => [path, index + 1] as const));
    const pathsById = new Map([...idByPath].map(([path, id]) => [id, path] as const));
    const imports = new Map<number, Set<number>>();
    const importedBy = new Map<number, Set<number>>();
    for (const [from, to] of edges) {
        const fromId = idByPath.get(from)!;
        const toId = idByPath.get(to)!;
        (imports.get(fromId) ?? imports.set(fromId, new Set()).get(fromId)!).add(toId);
        (importedBy.get(toId) ?? importedBy.set(toId, new Set()).get(toId)!).add(fromId);
    }
    return { pathsById, idByPath, imports, importedBy };
};

const CHAIN = graphOf([
    ["app.ts", "page.ts"],
    ["page.ts", "widget.ts"],
    ["widget.ts", "util.ts"],
    ["widget.test.ts", "widget.ts"],
]);

test("importers: one hop names direct importers only", () => {
    const result = impactOf(CHAIN, ["widget.ts"], { maxHops: 1, cap: 50, direction: "importers" });
    expect(result.reached).toEqual([
        { path: "page.ts", hops: 1 },
        { path: "widget.test.ts", hops: 1 },
    ]);
    expect(result.truncated).toBe(0);
});

test("importers: further hops carry their true distance, and the seed never appears", () => {
    const result = impactOf(CHAIN, ["widget.ts"], { maxHops: 3, cap: 50, direction: "importers" });
    expect(result.reached).toEqual([
        { path: "page.ts", hops: 1 },
        { path: "widget.test.ts", hops: 1 },
        { path: "app.ts", hops: 2 },
    ]);
    expect(result.reached.some((file) => file.path === "widget.ts")).toBe(false);
});

test("imports walks the other way: what the change leans on", () => {
    const result = impactOf(CHAIN, ["widget.ts"], { maxHops: 1, cap: 50, direction: "imports" });
    expect(result.reached).toEqual([{ path: "util.ts", hops: 1 }]);
});

test("both unions the directions at one hop", () => {
    const result = impactOf(CHAIN, ["widget.ts"], { maxHops: 1, cap: 50, direction: "both" });
    expect(result.reached.map((file) => file.path)).toEqual(["page.ts", "util.ts", "widget.test.ts"]);
});

test("the cap truncates by distance and reports what it dropped", () => {
    const result = impactOf(CHAIN, ["widget.ts"], { maxHops: 3, cap: 2, direction: "importers" });
    expect(result.reached.map((file) => file.path)).toEqual(["page.ts", "widget.test.ts"]);
    // app.ts is two hops out and therefore the one to lose, and the caller is told, never silently shortened.
    expect(result.truncated).toBe(1);
});

test("a seed the index has never seen is reported, not silently treated as unaffected", () => {
    const result = impactOf(CHAIN, ["brand-new.ts"], { maxHops: 2, cap: 50, direction: "both" });
    expect(result.unknownSeeds).toEqual(["brand-new.ts"]);
    expect(result.reached).toEqual([]);
});

test("a known seed alongside an unknown one still answers for the known one", () => {
    const result = impactOf(CHAIN, ["widget.ts", "brand-new.ts"], { maxHops: 1, cap: 50, direction: "importers" });
    expect(result.unknownSeeds).toEqual(["brand-new.ts"]);
    expect(result.reached.map((file) => file.path)).toEqual(["page.ts", "widget.test.ts"]);
});

test("a cycle terminates and each file is reported once, at its shortest distance", () => {
    const cyclic = graphOf([
        ["a.ts", "b.ts"],
        ["b.ts", "a.ts"],
        ["c.ts", "a.ts"],
    ]);
    const result = impactOf(cyclic, ["a.ts"], { maxHops: 10, cap: 50, direction: "both" });
    expect(result.reached).toEqual([
        { path: "b.ts", hops: 1 },
        { path: "c.ts", hops: 1 },
    ]);
});

test("several seeds share one frontier, so a file is scored from the nearest of them", () => {
    const result = impactOf(CHAIN, ["util.ts", "page.ts"], { maxHops: 2, cap: 50, direction: "importers" });
    // widget.ts is one hop from util.ts and app.ts is one hop from page.ts, so both land at 1 even though
    // widget.ts is two steps from the OTHER seed. Neither seed is reported, and the second hop off widget.ts
    // still reaches its test.
    expect(result.reached).toEqual([
        { path: "app.ts", hops: 1 },
        { path: "widget.ts", hops: 1 },
        { path: "widget.test.ts", hops: 2 },
    ]);
});
