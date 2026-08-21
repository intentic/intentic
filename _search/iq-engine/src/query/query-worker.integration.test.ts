import { afterAll, expect, test } from "vitest";
import { createResidentEngine, type ResidentEngine } from "../index.js";
import { makeFixtureWorkspace } from "../testing.js";
import type { QueryRequest } from "../types.js";

/* THE RESIDENT ENGINE'S SEMANTIC TIER NOW LIVES ON ANOTHER THREAD, and what these cover is that it still
 * ANSWERS, the worker path is the one that can break silently. A broken worker does not throw: the query
 * degrades to BM25 and returns a slightly worse answer, which is indistinguishable from a good day unless
 * something asserts on the tags.
 *
 * What is NOT asserted here is the latency property the worker exists for. Proving work happened off-thread
 * needs a side effect visible from this one: resident-thread.integration.test.ts has that, rows appearing in
 * SQLite while the host spins, and a request/response worker leaves none behind. Timing it instead would be a
 * throughput claim wearing a regression test's clothes, and it would breach on a loaded CI box. Those numbers
 * live in query-worker.ts's own header, measured against a real workspace index.
 *
 * One engine per fixture, never two on one root: a resident engine claims the index for writing, and a second
 * claimant is the exact collision the lock exists to prevent. */

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

// A host with no baked models is a supported configuration, and the worker says so rather than failing: the
// query keeps its BM25 half and the capsule names what is missing.
test("without a model dir the worker reports no backend and the query answers from BM25", async () => {
    const engine = await resident();
    const outcome = await engine.run(request("how are widgets built for the registry?"));
    expect(outcome.exitCode).toBe(0);
    expect(outcome.text).toContain("no embedding backend, BM25 only");
    expect(outcome.result.groups.flatMap((group) => group.hits).some((hit) => hit.tags.some((tag) => tag.kind === "bm25"))).toBe(true);
});

// Both model stages, end to end, across the thread boundary: the vectors are scored on the worker's own
// read-only handle and the cross-encoder runs there too, so tags for both are proof the round trip works.
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

// Concurrent turns are the daemon's normal state: several agents searching at once, and one thread answering
// all of them must not hand an answer to the wrong caller.
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
