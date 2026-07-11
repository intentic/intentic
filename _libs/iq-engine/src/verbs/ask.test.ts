import { afterAll, beforeAll, expect, test } from "vitest";
import { createEngine } from "../index.js";
import { makeFixtureWorkspace } from "../testing.js";
import type { QueryRequest } from "../types.js";

let root: string;
let cleanup: () => Promise<void>;

beforeAll(async () => {
    ({ root, cleanup } = await makeFixtureWorkspace());
});
afterAll(() => cleanup());

const request = (verb: QueryRequest["verb"], query: string): QueryRequest => ({
    verb,
    query,
    scope: {},
    render: { budget: 1500 },
    options: {},
    echo: `${verb} "${query}"`,
});

test("ask without a model runs BM25-ranked and says so", async () => {
    const engine = createEngine({ root });
    const outcome = await engine.run(request("ask", "how are widgets built for the registry?"));
    expect(outcome.exitCode).toBe(0);
    expect(outcome.text).toContain("no embedding backend — BM25 only");
    expect(outcome.result.groups.some((group) => group.path === "notes.md")).toBe(true);
    expect(outcome.result.groups.flatMap((group) => group.hits).some((hit) => hit.tags.some((tag) => tag.kind === "bm25"))).toBe(true);
});

// Real-model coverage, gated on a baked model dir (CI image job sets IQ_MODEL_DIR).
test.skipIf(process.env["IQ_MODEL_DIR"] === undefined)(
    "ask with baked models returns [sem]+[rerank]-tagged hits",
    async () => {
        const engine = createEngine({ root, modelDir: process.env["IQ_MODEL_DIR"]! });
        const outcome = await engine.run(request("ask", "where is a widget created?"));
        expect(outcome.exitCode).toBe(0);
        const tags = outcome.result.groups.flatMap((group) => group.hits).flatMap((hit) => hit.tags.map((tag) => tag.kind));
        expect(tags).toContain("sem");
        expect(tags).toContain("rerank");
        expect(outcome.text).toContain("reranked");
    },
    120_000,
);
