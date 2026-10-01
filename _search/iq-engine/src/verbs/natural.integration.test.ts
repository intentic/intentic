import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { requires } from "@intentic/testing/requires";
import { createEngine, parseFeatures, WEAK_FLOOR } from "../index.js";
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

// The weak floor end to end: the fixture holds widgets and nothing about payments, so a refund question must read weak
// and tell the reader what to do, while a question the registry answers must not. Both sit far from the floor
// (measured 2026-09-29: 0.998 and 0.00002), so neither flips when the floor is recalibrated.
test.skipIf(!models.runs)(
    models.title("a question nothing in the workspace answers reads weak, and one the workspace answers does not"),
    async () => {
        const engine = createEngine({ root, modelDir: MODEL_DIR });
        const answered = await engine.run(request("q", "how are widgets built for the registry?"));
        expect(answered.verdict?.confidence).toBe("confident");
        const absent = await engine.run(request("q", "how are payments refunded through Stripe?"));
        expect(absent.verdict?.confidence).toBe("weak");
        expect(absent.verdict?.relevance).toBeLessThan(WEAK_FLOOR);
        expect(absent.text).toMatch(/^answer: .* · weak · /m);
        expect(absent.result.hint).toMatch(/^weak match: /);
    },
    120_000,
);

// The cross-encoder is trained on web passages and scores prose that restates a question above the code that answers
// it; the class prior applies after its blend too, or that preference undid it.
test.skipIf(!models.runs)(
    models.title("source first: a doc restating the question leads without the class prior and yields to the code with it"),
    async () => {
        await mkdir(join(root, "docs"), { recursive: true });
        await writeFile(
            join(root, "docs/widget-creation.md"),
            "# Where is a widget created?\n\nA widget is created when you call the widget factory with a name: the new widget is created and returned.\n",
        );
        try {
            const question = request("q", "where is a widget created?");
            const without = await createEngine({ root, modelDir: MODEL_DIR }).run({ ...question, features: parseFeatures("-srcfirst") });
            expect(without.result.groups[0]?.path).toBe("docs/widget-creation.md");
            const withPrior = await createEngine({ root, modelDir: MODEL_DIR }).run(question);
            expect(withPrior.result.groups[0]?.path).toBe("alpha/src/widget.ts");
        } finally {
            await rm(join(root, "docs"), { recursive: true, force: true });
        }
    },
    120_000,
);
