import { afterAll, expect, test } from "vitest";
import { createResidentEngine, type ResidentEngine } from "../index.js";
import { makeFixtureWorkspace } from "../testing.js";
import type { QueryRequest } from "../types.js";

// Covers that the semantic tier still answers on a worker thread; a broken worker degrades silently to BM25 rather than
// throwing. Not a latency test; one engine per fixture, since a resident engine claims the index for writing.

const opened: { engine: ResidentEngine; cleanup: () => Promise<void> }[] = [];

afterAll(async () => {
    await Promise.all(
        opened.map(async ({ engine, cleanup }) => {
            await engine.close();
            await cleanup();
        }),
    );
});

const resident = async (modelDir?: string): Promise<ResidentEngine> => {
    const { root, cleanup } = await makeFixtureWorkspace();
    const engine = createResidentEngine({ root, ...(modelDir !== undefined ? { modelDir } : {}) });
    opened.push({ engine, cleanup });
    await engine.warm();
    return engine;
};

const request = (query: string): QueryRequest => ({
    verb: "q",
    query,
    scope: {},
    render: { budget: 1500 },
    options: {},
    echo: `q "${query}"`,
});

// A host with no baked models is a supported configuration; the worker reports it rather than failing, and the query
// still runs on BM25.
test("without a model dir the worker reports no backend and the query answers from BM25", async () => {
    const engine = await resident();
    const outcome = await engine.run(request("how are widgets built for the registry?"));
    expect(outcome.exitCode).toBe(0);
    expect(outcome.text).toContain("no embedding backend, BM25 only");
    expect(outcome.result.groups.flatMap((group) => group.hits).some((hit) => hit.tags.some((tag) => tag.kind === "bm25"))).toBe(true);
});

// Both model stages, across the thread boundary: vectors are scored on the worker's read-only handle and the
// cross-encoder runs there too, so both tags prove the round trip works.
test.skipIf(process.env["IQ_MODEL_DIR"] === undefined)(
    "with baked models the worker answers with [sem] and [rerank] hits",
    async () => {
        const engine = await resident(process.env["IQ_MODEL_DIR"]!);
        const outcome = await engine.run(request("where is a widget created?"));
        expect(outcome.exitCode).toBe(0);
        const tags = outcome.result.groups.flatMap((group) => group.hits).flatMap((hit) => hit.tags.map((tag) => tag.kind));
        expect(tags).toContain("sem");
        expect(tags).toContain("rerank");
        expect(outcome.text).toContain("reranked");
    },
    120_000,
);

test.skipIf(process.env["IQ_MODEL_DIR"] === undefined)(
    "queries in flight together each get their own answer",
    async () => {
        const engine = await resident(process.env["IQ_MODEL_DIR"]!);
        const [widget, registry] = await Promise.all([
            engine.run(request("where is a widget created?")),
            engine.run(request("what does the registry hold?")),
        ]);
        expect(widget?.text).toContain(`q "where is a widget created?"`);
        expect(registry?.text).toContain(`q "what does the registry hold?"`);
        expect(widget?.result.groups.length).toBeGreaterThan(0);
        expect(registry?.result.groups.length).toBeGreaterThan(0);
    },
    120_000,
);
