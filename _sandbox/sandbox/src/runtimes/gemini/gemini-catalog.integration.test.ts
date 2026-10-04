import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testConfig } from "../../testing.js";
import { createGeminiCatalog } from "./gemini-catalog.js";

// The translator's list is the catalog. Its ids are its own: it serves `gemini-3.8-flash-high` while Google's account
// metadata names `gemini-3.8-flash-tiered`, and turns on the translator's id run. Nothing may hide a listed id for
// lacking an exact twin in Google's metadata; a model Google really refuses is learned from its 404 (opencode-agent.ts).

let root: string;
beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "gemini-catalog-"));
});
afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

const translatorListing = (ids: readonly string[]): typeof fetch =>
    Object.assign(
        async (url: Parameters<typeof fetch>[0]) =>
            new Response(
                JSON.stringify(
                    String(url).endsWith("/v1beta/models") ? { models: [] } : { data: ids.map((id) => ({ id, owned_by: "antigravity" })) },
                ),
            ),
        { preconnect: () => undefined },
    );

test("every Google model the translator lists is offered, -high ids included", async () => {
    const listed = ["gemini-3.8-flash-high", "gemini-3.7-flash-high", "claude-opus-4-6-thinking"];
    const catalog = createGeminiCatalog(
        { ...testConfig, translator: { url: "http://127.0.0.1:8788", token: "local" } },
        join(root, "models.json"),
        translatorListing(listed),
    );

    expect((await catalog.models()).models.map((model) => model.id).sort()).toEqual([...listed].sort());
    expect((await catalog.live())?.map((model) => model.id).sort()).toEqual([...listed].sort());
});
