import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { Config } from "../env.config.js";
import { createCodexCatalog } from "./codex-catalog.js";
import { SEED_CODEX_MODELS } from "./codex-models.js";

/* The ORDER the catalog is served in, and therefore the model a fresh Codex conversation starts on: `default` is
 * the head of the list. OpenAI's /v1/models publishes a set in registry order — alphabetical in practice — so
 * taking its first id meant starting on GPT 5.1 while GPT 5.6 sat in the same response. See model-order.ts. */

const translatorConfig = { translator: { url: "http://127.0.0.1:8788", token: "local-bearer" }, openaiApiKey: "" } as unknown as Config;
const offlineConfig = { translator: { url: "", token: "" }, openaiApiKey: "" } as unknown as Config;

const translatorServes =
    (ids: string[]): typeof fetch =>
    async () =>
        new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), { status: 200 });

const persistPath = async (): Promise<string> => join(await mkdtemp(join(tmpdir(), "codex-catalog-")), "models.json");

test("serves a registry-ordered catalog frontier-newest-first, and starts conversations on its head", async () => {
    const alphabetical = ["gpt-5.1-codex", "gpt-5.4-mini", "gpt-5.5", "gpt-5.6-sol"];

    const catalog = await createCodexCatalog(translatorConfig, await persistPath(), translatorServes(alphabetical)).models();

    expect(catalog.models.map((model) => model.id)).toEqual(["gpt-5.6-sol", "gpt-5.5", "gpt-5.1-codex", "gpt-5.4-mini"]);
    expect(catalog.default).toBe("gpt-5.6-sol");
});

test("orders the self-healed catalog too — a turn's rejection names ids, it doesn't rank them", async () => {
    const service = createCodexCatalog(offlineConfig, await persistPath());
    await service.record(["gpt-5.4-mini", "gpt-5.6-sol"]);

    expect((await service.models()).default).toBe("gpt-5.6-sol");
});

test("keeps the id some accounts reject off the seed floor's default", async () => {
    // gpt-5.1 and gpt-5.1-codex are the same release of two lines, so tier and version separate neither: the id
    // itself settles it, and a variant id is its base id plus a suffix — so the plain chat model, which is the
    // one every account can drive, leads its own -codex sibling by construction rather than by luck.
    const catalog = await createCodexCatalog(offlineConfig, await persistPath()).models();

    expect(catalog.models.map((model) => model.id)).toEqual([...SEED_CODEX_MODELS]);
    expect(catalog.default).toBe(SEED_CODEX_MODELS[0]);
});
