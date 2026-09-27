import { existsSync } from "node:fs";
import { requires } from "@intentic/testing/requires";
import { createEngine } from "../index.js";
import { makeFixtureWorkspace } from "../testing.js";
import type { QueryRequest } from "../types.js";

// The models scripts/fetch-model.mjs bakes into the sandbox image, where IQ_MODEL_DIR names them. CI's verify-machine job
// restores them from the images' own cache and runs this file (ci.yml); every other CI job stands these tests down.
const MODEL_DIR = process.env["IQ_MODEL_DIR"] ?? "";
const models = requires(MODEL_DIR !== "" && existsSync(MODEL_DIR), "the iq models at IQ_MODEL_DIR (scripts/fetch-model.mjs)", { lane: "machine" });

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

test("a natural-language query without a model runs BM25-ranked and says so", async () => {
    const engine = createEngine({ root });
    const outcome = await engine.run(request("q", "how are widgets built for the registry?"));
    expect(outcome.exitCode).toBe(0);
    expect(outcome.text).toContain("no embedding backend, BM25 only");
    expect(outcome.result.groups.some((group) => group.path === "notes.md")).toBe(true);
    expect(outcome.result.groups.flatMap((group) => group.hits).some((hit) => hit.tags.some((tag) => tag.kind === "bm25"))).toBe(true);
});

// Real-model coverage, against the baked models.
test.skipIf(!models.runs)(
    models.title("a natural-language query with baked models returns [sem]+[rerank]-tagged hits"),
    async () => {
        const engine = createEngine({ root, modelDir: MODEL_DIR });
        const outcome = await engine.run(request("q", "where is a widget created?"));
        expect(outcome.exitCode).toBe(0);
        const tags = outcome.result.groups.flatMap((group) => group.hits).flatMap((hit) => hit.tags.map((tag) => tag.kind));
        expect(tags).toContain("sem");
        expect(tags).toContain("rerank");
        expect(outcome.text).toContain("reranked");
    },
    120_000,
);
