import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KEY_PROVIDERS, type KeyProvider, keyEndpointOf, type Model, ModelSchema } from "@intentic/sandbox-contract";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { jsonFile } from "../store/json-file.js";
import { createKeyedCatalog } from "./keyed-catalog.js";
import type { KeyedStore } from "./keyed-credentials.js";
import { seedModelsOf } from "./keyed-provider.js";

/* WHAT ACTUALLY GOES OUT ON THE WIRE when a keyed provider's catalog is read, which is the half a conformance
 * test cannot reach.
 *
 * A spec row can be complete, typed and wrong: a base URL pointing at the general Z.ai entitlement instead of
 * the Coding Plan one, or a key sent as `x-api-key` because that is what "Anthropic-compatible" suggests, both
 * compile, both pass every table-walking assertion, and both fail only against the real vendor. So the request
 * is made against a stub that records it, and the URL and headers are asserted.
 *
 * DRIVEN BY THE SPEC TABLE, so a provider added tomorrow is exercised the day it is added rather than the day
 * somebody remembers to copy a describe block. */

const catalogFor = async (
    provider: KeyProvider,
    respond: (request: { url: string; headers: Headers }) => Response,
    options: { key?: string } = {},
): Promise<{ catalog: { models: Model[]; default: string }; seen: { url: string; headers: Headers }[] }> => {
    const dir = await mkdtemp(join(tmpdir(), `keyed-catalog-${provider}-`));
    const seen: { url: string; headers: Headers }[] = [];
    const key = options.key ?? "test-key";
    const store: Pick<KeyedStore, "credentials"> = {
        credentials: async () => (key === "" ? [] : [{ id: "a", apiKey: key, connectedAt: 1 }]),
    };
    const fetchImpl = (async (url: string, init?: RequestInit) => {
        const request = { url: String(url), headers: new Headers(init?.headers) };
        seen.push(request);
        return respond(request);
    }) as unknown as typeof fetch;
    const catalog = createKeyedCatalog({
        provider,
        store,
        seed: seedModelsOf(provider),
        file: jsonFile<Model[]>(join(dir, "models.json"), { parse: (raw) => z.array(ModelSchema).safeParse(raw).data, fallback: () => [] }),
        fetchImpl,
    });
    return { catalog: await catalog.models(), seen };
};

const listing = (ids: readonly string[]): Response =>
    new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), { headers: { "content-type": "application/json" } });

describe.each(KEY_PROVIDERS.map((provider) => ({ provider })))("$provider's catalog read", ({ provider }) => {
    const endpoint = keyEndpointOf(provider)!;

    test("goes to the vendor's own /models, with the key as a bearer", async () => {
        const { seen } = await catalogFor(provider, () => listing(["a-model"]));
        expect(seen).toHaveLength(1);
        // The exact URL, not a prefix: a base with a stray slash or a doubled version segment is a 404 that
        // shows up as an empty picker, which reads as "this provider has no models".
        expect(seen[0]?.url).toBe(`${endpoint.catalogBase}/models`);
        expect(seen[0]?.headers.get("authorization")).toBe("Bearer test-key");
        /* NOT `x-api-key`, and this is the assertion with a real failure behind it. These providers speak the
         * Anthropic Messages API for TURNS, which is the header that world uses, and the catalog is read over
         * the OpenAI-compatible surface, which is not. Sending the wrong one is a 401 whose only symptom is a
         * provider that never publishes a model. */
        expect(seen[0]?.headers.get("x-api-key")).toBeNull();
        expect(seen[0]?.headers.get("anthropic-version")).toBeNull();
    });

    test("publishes what the vendor listed, ordered by the shared rule", async () => {
        // Deliberately handed back in a bad order, which is what a registry-ordered set does in practice.
        const { catalog } = await catalogFor(provider, () => listing(["zzz-1", "zzz-3", "zzz-2"]));
        expect(catalog.models.map((model) => model.id)).toEqual(["zzz-3", "zzz-2", "zzz-1"]);
        // The head IS the model a fresh conversation opens on, so it is asserted as such rather than inferred.
        expect(catalog.default).toBe("zzz-3");
    });

    test("drops the non-chat rows a vendor lists beside its models", async () => {
        const { catalog } = await catalogFor(provider, () => listing(["chat-9", "text-embedding-3", "whisper-1"]));
        expect(catalog.models.map((model) => model.id)).toEqual(["chat-9"]);
    });

    /* A REFUSED KEY FALLS TO THE SEED, NOT TO NOTHING, and the difference is what the picker says to a person
     * whose key has just been revoked: a floor still shows what this provider serves, under a badge saying it
     * needs connecting, where an empty catalog reads as a provider that has stopped existing. It is also what
     * keeps a turn resolvable: routedModel needs a default, and an empty catalog has none. */
    test("a refused key falls back to the seed floor rather than emptying the picker", async () => {
        const { catalog } = await catalogFor(provider, () => new Response("unauthorized", { status: 401 }));
        expect(catalog.models.map((model) => model.id)).toEqual(seedModelsOf(provider).map((model) => model.id));
        expect(catalog.default).toBe(seedModelsOf(provider)[0]?.id);
    });

    test("a provider with no key connected is not asked at all, and still offers its floor", async () => {
        const { catalog, seen } = await catalogFor(provider, () => listing(["never-reached"]), { key: "" });
        // No credential, no request: asking anonymously would spend a round-trip to be refused, on every read.
        expect(seen).toHaveLength(0);
        expect(catalog.models.map((model) => model.id)).toEqual(seedModelsOf(provider).map((model) => model.id));
    });

    test("a body that is not a catalog is treated as no answer, never as an empty one", async () => {
        const { catalog } = await catalogFor(provider, () => new Response("<html>gateway</html>", { headers: { "content-type": "text/html" } }));
        expect(catalog.models.length).toBeGreaterThan(0);
    });
});
