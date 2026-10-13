import { services, withTranslator } from "../../../harness/route-services.testing.js";
import { type OpenCodeRouteEntry, openCodeRouteEntries, openCodeRouteId, routeLabelOf, routeProviderConfig, routeSignature } from "./opencode-routes.js";

// The hosted providers as the shared OpenCode server is told about them: one entry per route the resolver answers, each
// speaking its wire through the SDK package OpenCode bundles for it.

const entry = (overrides: Partial<OpenCodeRouteEntry> = {}): OpenCodeRouteEntry => ({
    id: "intentic-route-codex",
    provider: "codex",
    label: "Codex",
    wire: "openai-responses",
    base: "http://127.0.0.1:8788",
    path: "/v1",
    token: "local-bearer",
    shield: "codex",
    models: [{ id: "gpt-5.5", efforts: ["low", "high"], contextWindow: 400_000 }],
    ...overrides,
});

test("each wire is spoken through its own bundled package, tiers set the way that package takes them", () => {
    const providers = routeProviderConfig([
        entry(),
        entry({ id: "intentic-route-kimi", provider: "kimi", label: "Kimi Code", wire: "openai-chat", models: [{ id: "kimi-k3", efforts: ["high"] }] }),
        entry({ id: "intentic-route-endpoint-relay", provider: "endpoint/relay", label: "relay", wire: "anthropic-messages", models: [{ id: "m", efforts: ["high"] }] }),
    ]);
    expect(providers["intentic-route-codex"]).toMatchObject({
        package: "aisdk:@ai-sdk/openai",
        settings: { baseURL: "http://127.0.0.1:8788/v1", apiKey: "local-bearer" },
        models: {
            "gpt-5.5": {
                capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
                variants: [
                    { id: "low", settings: { reasoningEffort: "low" } },
                    { id: "high", settings: { reasoningEffort: "high" } },
                ],
                limit: { context: 400_000 },
            },
        },
    });
    expect(providers["intentic-route-kimi"]).toMatchObject({
        package: "aisdk:@ai-sdk/openai-compatible",
        models: { "kimi-k3": { capabilities: { input: ["text"] }, variants: [{ id: "high", body: { reasoning_effort: "high" } }] } },
    });
    // Anthropic's thinking takes a budget, not a tier: no variant OpenCode would send wrong.
    expect(providers["intentic-route-endpoint-relay"]?.package).toBe("aisdk:@ai-sdk/anthropic");
    expect(providers["intentic-route-endpoint-relay"]?.models?.["m"]?.variants).toBeUndefined();
});

test("a route with no models is left out, since OpenCode can route nothing to it", () => {
    expect(routeProviderConfig([entry({ models: [] })])).toEqual({});
});

test("the signature moves with a reconnected key and a new model, not with the order discovery returned", () => {
    const two = [entry(), entry({ id: "intentic-route-kimi", provider: "kimi" })];
    expect(routeSignature(two)).toBe(routeSignature(two.toReversed()));
    expect(routeSignature([entry({ token: "rotated" })])).not.toBe(routeSignature([entry()]));
    expect(routeSignature([entry({ models: [{ id: "gpt-5.5" }, { id: "gpt-5.6" }] })])).not.toBe(routeSignature([entry()]));
});

test("an account's entry is its own id, and every id reads back to the name a failure sentence uses", () => {
    expect(openCodeRouteId("zai", "Z.ai-1")).toBe("intentic-route-zai--Z-ai-1");
    expect(routeLabelOf(openCodeRouteId("zai", "Z.ai-1"))).toBe("Z.ai");
    expect(routeLabelOf(openCodeRouteId("codex"))).toBe("ChatGPT");
    expect(routeLabelOf(openCodeRouteId("endpoint/lab"))).toBe("lab");
    expect(routeLabelOf("xai")).toBeUndefined();
});

test("the entries are every route that resolves now: the translator's pools signed in, each Z.ai key, each endpoint", async () => {
    const sandbox = services({
        config: withTranslator,
        cliProxy: { accounts: async () => ({ codex: [], grok: [], kimi: [{ name: "k.json", label: "k" }], gemini: [] }) },
        endpointModels: { models: async () => ({ models: [{ id: "qwen3", label: "qwen3" }], default: "qwen3" }), forget: async () => {} },
    });
    const { id: account } = await sandbox.minted.zai.store.connect({ apiKey: "zai-key", variant: "zai" });
    await sandbox.capabilities.upsert({ id: "lab", kind: "endpoint", config: { baseUrl: "http://lab.test/v1", protocol: "openai", apiKey: "owner" } });

    const entries = await openCodeRouteEntries(sandbox);

    expect(entries.map((found) => found.id).toSorted()).toEqual(["intentic-route-endpoint-lab", "intentic-route-kimi", openCodeRouteId("zai", account)].toSorted());
    expect(entries.find((found) => found.provider === "zai")).toMatchObject({ base: "https://api.z.ai/api/coding/paas", path: "/v4", token: "zai-key", wire: "openai-chat" });
    expect(entries.find((found) => found.provider === "endpoint/lab")).toMatchObject({ base: "http://lab.test", path: "/v1", token: "owner", models: [{ id: "qwen3" }] });
});
