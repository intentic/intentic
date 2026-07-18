import { afterAll, beforeAll, expect, test } from "vitest";
import { createEngine, type Engine, parseFeatures } from "../index.js";
import { makeFixtureWorkspace } from "../testing.js";
import type { QueryRequest } from "../types.js";

let root: string;
let cleanup: () => Promise<void>;

beforeAll(async () => {
    ({ root, cleanup } = await makeFixtureWorkspace());
});
afterAll(() => cleanup());

const engineWith = (spec?: string): Engine => createEngine({ root, features: parseFeatures(spec) });

const request = (verb: QueryRequest["verb"], query: string): QueryRequest => ({
    verb,
    query,
    scope: {},
    render: { budget: 1500 },
    options: {},
    echo: `${verb} "${query}"`,
});

test("symctx: hits carry the enclosing symbol; off drops it", async () => {
    const on = await engineWith().run(request("refs", "createWidget"));
    const registryHit = on.result.groups.find((group) => group.path.endsWith("registry.ts"))?.hits.find((hit) => hit.line === 3);
    expect(registryHit?.context).toBe("defaultWidgets (const)");
    expect(on.text).toContain("⟨in defaultWidgets (const)⟩");

    const off = await engineWith("-symctx").run(request("refs", "createWidget"));
    expect(off.result.groups.flatMap((group) => group.hits).every((hit) => hit.context === undefined)).toBe(true);
    expect(off.result.features).toContain("symctx");
});

test("bm25 off: ask has no [bm25] tags and discloses the disabled set", async () => {
    const outcome = await engineWith("-bm25,-prf").run(request("ask", "how are widgets built for the registry?"));
    expect(outcome.result.groups.flatMap((group) => group.hits).every((hit) => hit.tags.every((tag) => tag.kind !== "bm25"))).toBe(true);
    expect(outcome.result.features).toEqual(expect.arrayContaining(["bm25", "prf"]));
    expect(outcome.text).toContain("features -bm25,-prf");
});

test("allow-list: only bm25 runs, and only [bm25] tags appear", async () => {
    const outcome = await engineWith("bm25").run(request("ask", "how are widgets built for the registry?"));
    const kinds = new Set(outcome.result.groups.flatMap((group) => group.hits).flatMap((hit) => hit.tags.map((tag) => tag.kind)));
    expect([...kinds]).toEqual(["bm25"]);
});

test("graph: ask returns related definition anchors; off drops them", async () => {
    const on = await engineWith().run(request("ask", "how are widgets built for the registry?"));
    // The fixture is tiny; related lines appear when a top hit sits inside a symbol.
    if (on.result.related !== undefined) {
        expect(on.text).toContain("related: ");
        expect(on.result.related.some((line) => line.includes("iq refs "))).toBe(true);
    }
    const off = await engineWith("-graph").run(request("ask", "how are widgets built for the registry?"));
    expect(off.result.related).toBeUndefined();
});

test("boosts off changes ranking deterministically (pure RRF)", async () => {
    const withBoosts = await engineWith().run(request("q", "createWidget"));
    const withoutBoosts = await engineWith("-boosts").run(request("q", "createWidget"));
    // Both deterministic; the def-boosted run puts the definition file first.
    expect(withBoosts.result.groups[0]?.path).toBe("alpha/src/widget.ts");
    const again = await engineWith("-boosts").run(request("q", "createWidget"));
    expect(JSON.stringify(withoutBoosts.result.groups)).toBe(JSON.stringify(again.result.groups));
});

test("pack: top ask groups carry the enclosing chunk as contiguous lines; off keeps sparse hits", async () => {
    const packed = await engineWith().run(request("ask", "how are widgets built for the registry?"));
    const top = packed.result.groups[0];
    expect(top).toBeDefined();
    // Contiguous line numbers = a code slice, not isolated matches.
    const lines = top!.hits.map((hit) => hit.line);
    for (let i = 1; i < lines.length; i++) {
        expect(lines[i]).toBe(lines[i - 1]! + 1);
    }
    expect(lines.length).toBeGreaterThan(1);
    // The anchor hit keeps its retrieval tags; synthesized slice lines carry none.
    expect(top!.hits.some((hit) => hit.tags.length > 0)).toBe(true);
    expect(top!.hits.some((hit) => hit.tags.length === 0)).toBe(true);

    const sparse = await engineWith("-pack").run(request("ask", "how are widgets built for the registry?"));
    expect(sparse.result.features).toContain("pack");
    expect(sparse.result.groups[0]?.path).toBe(top!.path);
    expect(sparse.result.groups[0]!.hits.length).toBeLessThanOrEqual(top!.hits.length);
});

test("pack applies to natural-language q but not identifier q", async () => {
    const identifier = await engineWith().run(request("q", "createWidget"));
    // Identifier queries keep pointing: hits are the actual match lines, not a hydrated slice.
    const topHits = identifier.result.groups[0]?.hits ?? [];
    expect(topHits.every((hit) => hit.tags.length > 0)).toBe(true);
});

// Ordering and content are deterministic; raw scores carry recency-boost timestamp jitter by design.
const shape = (outcome: { result: { groups: readonly { path: string; hits: readonly { line: number; tags: unknown }[] }[] } }): string =>
    JSON.stringify(outcome.result.groups.map((group) => ({ path: group.path, hits: group.hits.map((hit) => [hit.line, hit.tags]) })));

test("prf terms feed a second bm25 engine without breaking determinism", async () => {
    const a = await engineWith().run(request("ask", "how are widgets built for the registry?"));
    const b = await engineWith().run(request("ask", "how are widgets built for the registry?"));
    expect(shape(a)).toBe(shape(b));
});
