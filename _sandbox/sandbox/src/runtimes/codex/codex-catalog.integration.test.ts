import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "@intentic/sandbox-contract";
import type { Config } from "../../env.config.js";
import { createCodexCatalog } from "./codex-catalog.js";
import { SEED_CODEX_MODELS } from "./codex-models.js";

/* The ORDER the catalog is served in, and therefore the model a fresh Codex conversation starts on: `default` is the head of the list. */

const translatorConfig = { translator: { url: "http://127.0.0.1:8788", token: "local-bearer" }, openaiApiKey: "" } as unknown as Config;
const offlineConfig = { translator: { url: "", token: "" }, openaiApiKey: "" } as unknown as Config;

const translatorServes = (ids: string[]): typeof fetch =>
    (async () => new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), { status: 200 })) as unknown as typeof fetch;

// What the Codex CLI's own model/list publishes, trimmed to the fields the catalog reads. Ordered as Codex orders it:
// its default first.
const CODEX_PUBLISHES: Model[] = [
    { id: "gpt-6-astra", label: "GPT-6-Astra", efforts: ["low", "medium", "high", "xhigh", "max", "ultra"], description: "Our most capable model." },
    { id: "gpt-5.6-sol", label: "GPT-5.6-Sol", efforts: ["low", "medium", "high", "xhigh", "max", "ultra"] },
    { id: "gpt-5.6-luna", label: "GPT-5.6-Luna", efforts: ["low", "medium", "high", "xhigh", "max"] },
    { id: "gpt-5.5", label: "GPT-5.5", efforts: ["low", "medium", "high", "xhigh"] },
];

const codexHome = async (): Promise<string> => mkdtemp(join(tmpdir(), "codex-catalog-"));
// No app-server in reach is the ordinary case for a test; the ids-only ladder has to stand on its own.
const listsNothing = async (): Promise<readonly Model[]> => [];

test("serves a registry-ordered catalog frontier-newest-first, and starts conversations on its head", async () => {
    const alphabetical = ["gpt-5.1-codex", "gpt-5.4-mini", "gpt-5.5", "gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra"];

    const catalog = await createCodexCatalog(translatorConfig, await codexHome(), {
        fetchImpl: translatorServes(alphabetical),
        listModels: listsNothing,
    }).models();

    expect(catalog.models.map((model) => model.id)).toEqual([
        "gpt-5.6-sol",
        "gpt-5.6-terra",
        "gpt-5.6-luna",
        "gpt-5.5",
        "gpt-5.1-codex",
        "gpt-5.4-mini",
    ]);
    expect(catalog.default).toBe("gpt-5.6-sol");
});

test("dresses the subscription's ids in what the runtime publishes about them: scale, name and description", async () => {
    // /v1/models says which models the subscription may drive; model/list says what each one accepts. A row the
    // runtime didn't mention still serves, on its id alone.
    const catalog = await createCodexCatalog(translatorConfig, await codexHome(), {
        fetchImpl: translatorServes(["gpt-5.6-sol", "gpt-5.6-luna", "gpt-5.4-mini"]),
        listModels: async () => CODEX_PUBLISHES,
    }).models();

    expect(catalog.models).toEqual([CODEX_PUBLISHES[1]!, CODEX_PUBLISHES[2]!, { id: "gpt-5.4-mini", label: "GPT 5.4 Mini" }]);
});

test("serves the runtime's own catalog, in its own order, when no id source is configured", async () => {
    // A native ChatGPT-account sandbox has no translator and no API key: the CLI that will run the turn is the only
    // source there is, and the model it leads with is the one a fresh conversation opens on.
    const catalog = await createCodexCatalog(offlineConfig, await codexHome(), { listModels: async () => CODEX_PUBLISHES }).models();

    expect(catalog.models).toEqual(CODEX_PUBLISHES);
    expect(catalog.default).toBe("gpt-6-astra");
});

test("orders the self-healed catalog too: a turn's rejection names ids, it doesn't rank them", async () => {
    const service = createCodexCatalog(offlineConfig, await codexHome(), { listModels: listsNothing });
    await service.record(["gpt-5.4-mini", "gpt-5.6-sol"]);

    expect((await service.models()).default).toBe("gpt-5.6-sol");
});

test("keeps the id some accounts reject off the seed floor's default", async () => {
    // gpt-5.1 and gpt-5.1-codex are the same release of two lines, so tier and version separate neither: the id
    // itself settles it, and a variant id is its base id plus a suffix, so the plain chat model, which is the
    // one every account can drive, leads its own -codex sibling by construction rather than by luck.
    const catalog = await createCodexCatalog(offlineConfig, await codexHome(), { listModels: listsNothing }).models();

    expect(catalog.models.map((model) => model.id)).toEqual([...SEED_CODEX_MODELS]);
    expect(catalog.default).toBe(SEED_CODEX_MODELS[0]!);
});
