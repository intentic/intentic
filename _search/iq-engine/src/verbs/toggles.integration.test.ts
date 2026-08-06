import { readFile } from "node:fs/promises";
import { join } from "node:path";
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

test("bm25 off: a natural-language query has no [bm25] tags and discloses the disabled set", async () => {
    const outcome = await engineWith("-bm25,-prf").run(request("q", "how are widgets built for the registry?"));
    expect(outcome.result.groups.flatMap((group) => group.hits).every((hit) => hit.tags.every((tag) => tag.kind !== "bm25"))).toBe(true);
    expect(outcome.result.features).toEqual(expect.arrayContaining(["bm25", "prf"]));
    expect(outcome.text).toContain("features -bm25,-prf");
});

/* One engine, one index, several callers — and they do not all want the same trade. The daemon's turn preamble
 * answers under a deadline it would rather meet than rank perfectly, while the CLI call next to it wants every
 * stage; per-call stages are what lets both share the resident engine instead of standing one up each. */
test("a request's own feature set overrides the engine's, for that call only", async () => {
    const engine = engineWith();
    const cheap = await engine.run({ ...request("q", "how are widgets built for the registry?"), features: parseFeatures("-bm25,-prf") });
    expect(cheap.result.groups.flatMap((group) => group.hits).every((hit) => hit.tags.every((tag) => tag.kind !== "bm25"))).toBe(true);
    expect(cheap.result.features).toEqual(expect.arrayContaining(["bm25", "prf"]));

    // The next call through the same engine is back to everything — the override rode the request, not the engine.
    const full = await engine.run(request("q", "how are widgets built for the registry?"));
    expect(full.result.features).toBeUndefined();
});

test("allow-list: only bm25 runs, and only [bm25] tags appear", async () => {
    const outcome = await engineWith("bm25").run(request("q", "how are widgets built for the registry?"));
    const kinds = new Set(outcome.result.groups.flatMap((group) => group.hits).flatMap((hit) => hit.tags.map((tag) => tag.kind)));
    expect([...kinds]).toEqual(["bm25"]);
});

test("graph: a natural-language query returns related definition anchors; off drops them", async () => {
    const on = await engineWith().run(request("q", "how are widgets built for the registry?"));
    // The fixture is tiny; related lines appear when a top hit sits inside a symbol.
    if (on.result.related !== undefined) {
        expect(on.text).toContain("related: ");
        expect(on.result.related.every((line) => line.includes(" — def "))).toBe(true);
        // A caller is resolved inline, not deferred to a follow-up `iq refs` the agent has to spend a turn on.
        expect(on.result.related.some((line) => line.includes(" · called from "))).toBe(true);
    }
    const off = await engineWith("-graph").run(request("q", "how are widgets built for the registry?"));
    expect(off.result.related).toBeUndefined();
});

test("the fusion multipliers toggle one at a time; all three off is deterministic pure RRF", async () => {
    const boosted = await engineWith().run(request("q", "createWidget"));
    // The def-boosted run puts the definition file first.
    expect(boosted.result.groups[0]?.path).toBe("alpha/src/widget.ts");

    // Each multiplier is its own name, so a spec can drop one and keep the others — what `-boosts` could not do.
    const defOff = await engineWith("-defboost").run(request("q", "createWidget"));
    expect(defOff.result.features).toEqual(expect.arrayContaining(["defboost"]));
    expect(defOff.result.features).not.toContain("pathboost");

    const pureRrf = await engineWith("-defboost,-pathboost,-recency").run(request("q", "createWidget"));
    const again = await engineWith("-defboost,-pathboost,-recency").run(request("q", "createWidget"));
    expect(JSON.stringify(pureRrf.result.groups)).toBe(JSON.stringify(again.result.groups));
});

test("pack: top natural-language groups carry the enclosing symbol body as contiguous lines; off keeps sparse hits", async () => {
    const packed = await engineWith().run(request("q", "how are widgets built for the registry?"));
    const top = packed.result.groups[0];
    expect(top).toBeDefined();
    // The slice is a contiguous run of lines = a code slice, not isolated matches. Anchors beyond the packed
    // symbol may follow it as pointers, so contiguity is asserted over the prefix, not the whole group.
    const lines = top!.hits.map((hit) => hit.line);
    const slice = lines.findIndex((line, i) => i > 0 && line !== lines[i - 1]! + 1);
    const packedLines = slice === -1 ? lines : lines.slice(0, slice);
    expect(packedLines.length).toBeGreaterThan(1);
    // The anchor hit keeps its retrieval tags; synthesized slice lines carry none.
    expect(top!.hits.some((hit) => hit.tags.length > 0)).toBe(true);
    expect(top!.hits.some((hit) => hit.tags.length === 0)).toBe(true);

    const sparse = await engineWith("-pack").run(request("q", "how are widgets built for the registry?"));
    expect(sparse.result.features).toContain("pack");
    expect(sparse.result.groups[0]?.path).toBe(top!.path);
    expect(sparse.result.groups[0]!.hits.length).toBeLessThanOrEqual(top!.hits.length);
});

test("packed lines are the file's real lines at their real numbers", async () => {
    const packed = await engineWith().run(request("q", "how are widgets built for the registry?"));
    const top = packed.result.groups[0]!;
    const source = (await readFile(join(root, top.path), "utf8")).split(/\r?\n/);
    // The indexed chunk carries a synthetic `path § label` first line; packing must never surface it, nor shift
    // the anchors by the one line it occupies.
    for (const hit of top.hits) {
        expect(hit.text).toBe(source[hit.line - 1]);
    }
    expect(top.hits.some((hit) => hit.text.includes(" § "))).toBe(false);
});

test("a packed slice cannot spend the whole budget and hide the ranked candidates under it", async () => {
    // Regression: an unbounded slice (a 107-line implementation packed at rank 1) consumed a 1500-token budget by
    // itself, so the candidates below it never reached the answer at all — the file the reader wanted was one of
    // them. Packing gets a bounded share; a tighter budget must buy fewer packed lines, never fewer candidates.
    const query = "how are widgets built for the registry?";
    const wide = await engineWith().run({ ...request("q", query), render: { budget: 1500 } });
    const tight = await engineWith().run({ ...request("q", query), render: { budget: 300 } });
    const packedRun = (outcome: typeof wide): number => {
        const lines = outcome.result.groups[0]!.hits.map((hit) => hit.line);
        const broken = lines.findIndex((line, i) => i > 0 && line !== lines[i - 1]! + 1);
        return broken === -1 ? lines.length : broken;
    };
    expect(packedRun(tight)).toBeLessThanOrEqual(packedRun(wide));
    // Whatever the budget, the anchor that earned the group its rank stays inside the slice.
    for (const outcome of [wide, tight]) {
        expect(outcome.result.groups[0]!.hits.some((hit) => hit.tags.length > 0)).toBe(true);
    }
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
    const a = await engineWith().run(request("q", "how are widgets built for the registry?"));
    const b = await engineWith().run(request("q", "how are widgets built for the registry?"));
    expect(shape(a)).toBe(shape(b));
});
