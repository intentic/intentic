import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MINTED_PROVIDERS, type MintedProvider, type MintedVariant, mintedVariants, type Model, ModelSchema } from "@intentic/sandbox-contract";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { jsonFile } from "../../store/json-file.js";
import { createMintedCatalog } from "./minted-catalog.js";
import type { MintedStore } from "./minted-credentials.js";
import { seedModelsOf } from "./minted-provider.js";

// Exercises what actually goes out on the wire for a minted provider's catalog read (URL, headers), against every
// estate on the spec table, since a spec row can be typed and wrong yet pass a table-walking test.

const catalogFor = async (
    provider: MintedProvider,
    variant: MintedVariant,
    respond: (request: { url: string; headers: Headers }) => Response,
    options: { key?: string; keyVariant?: string } = {},
): Promise<{ catalog: { models: Model[]; default: string }; seen: { url: string; headers: Headers }[] }> => {
    const dir = await mkdtemp(join(tmpdir(), `minted-catalog-${provider}-`));
    const seen: { url: string; headers: Headers }[] = [];
    const key = options.key ?? "test-key";
    const store: Pick<MintedStore, "credentials"> = {
        credentials: async () => (key === "" ? [] : [{ id: "a", apiKey: key, variant: options.keyVariant ?? variant.id, connectedAt: 1 }]),
    };
    const fetchImpl = (async (url: string, init?: RequestInit) => {
        const request = { url: String(url), headers: new Headers(init?.headers) };
        seen.push(request);
        return respond(request);
    }) as unknown as typeof fetch;
    const catalog = createMintedCatalog({
        provider,
        variant,
        store,
        seed: seedModelsOf(provider),
        file: jsonFile<Model[]>(join(dir, "models.json"), { parse: (raw) => z.array(ModelSchema).safeParse(raw).data, fallback: () => [] }),
        fetchImpl,
    });
    return { catalog: await catalog.models(), seen };
};

const listing = (ids: readonly string[]): Response =>
    new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), { headers: { "content-type": "application/json" } });

// Every estate of every minted provider, off the table, so a provider added tomorrow is exercised the day it's added.
const estates = MINTED_PROVIDERS.flatMap((provider) =>
    (mintedVariants(provider) ?? []).map((variant) => ({ provider, variant, name: `${provider}/${variant.id}` })),
);

describe.each(estates)("$name's catalog read", ({ provider, variant }) => {
    test("goes to that estate's own /models, with the key as a bearer", async () => {
        const { seen } = await catalogFor(provider, variant, () => listing(["a-model"]));
        expect(seen).toHaveLength(1);
        // The exact URL, not a prefix: a stray slash or doubled version segment 404s, which reads as an empty picker.
        expect(seen[0]?.url).toBe(`${variant.catalogBase}/models`);
        expect(seen[0]?.headers.get("authorization")).toBe("Bearer test-key");
        // Not x-api-key: turns speak the Anthropic Messages API, but the catalog is read over the OpenAI-compatible
        // surface, and sending the wrong header 401s silently.
        expect(seen[0]?.headers.get("x-api-key")).toBeNull();
        expect(seen[0]?.headers.get("anthropic-version")).toBeNull();
    });

    test("publishes what the vendor listed, ordered by the shared rule", async () => {
        // Deliberately handed back in a bad order, which is what a registry-ordered set does in practice.
        const { catalog } = await catalogFor(provider, variant, () => listing(["zzz-1", "zzz-3", "zzz-2"]));
        expect(catalog.models.map((model) => model.id)).toEqual(["zzz-3", "zzz-2", "zzz-1"]);
        // The head IS the model a fresh conversation opens on, so it is asserted as such rather than inferred.
        expect(catalog.default).toBe("zzz-3");
    });

    test("drops the non-chat rows a vendor lists beside its models", async () => {
        const { catalog } = await catalogFor(provider, variant, () => listing(["chat-9", "text-embedding-3", "whisper-1"]));
        expect(catalog.models.map((model) => model.id)).toEqual(["chat-9"]);
    });

    // An empty catalog also breaks routedModel, which needs a default to resolve a turn.
    test("a refused key falls back to the seed floor rather than emptying the picker", async () => {
        const { catalog } = await catalogFor(provider, variant, () => new Response("unauthorized", { status: 401 }));
        expect(catalog.models.map((model) => model.id)).toEqual(seedModelsOf(provider).map((model) => model.id));
        expect(catalog.default).toBe(seedModelsOf(provider)[0]?.id);
    });

    test("a provider with no key connected is not asked at all, and still offers its floor", async () => {
        const { catalog, seen } = await catalogFor(provider, variant, () => listing(["never-reached"]), { key: "" });
        // No credential, no request: asking anonymously would spend a round-trip to be refused, on every read.
        expect(seen).toHaveLength(0);
        expect(catalog.models.map((model) => model.id)).toEqual(seedModelsOf(provider).map((model) => model.id));
    });

    // A mismatched key isn't just refused: it can succeed against a host listing models it can't actually run, so the
    // store filters by estate first.
    test("another estate's key is not used here", async () => {
        const { seen } = await catalogFor(provider, variant, () => listing(["never-reached"]), { keyVariant: "some-other-estate" });
        expect(seen).toHaveLength(0);
    });

    test("a body that is not a catalog is treated as no answer, never as an empty one", async () => {
        const { catalog } = await catalogFor(provider, variant, () => new Response("<html>gateway</html>", { headers: { "content-type": "text/html" } }));
        expect(catalog.models.length).toBeGreaterThan(0);
    });
});
