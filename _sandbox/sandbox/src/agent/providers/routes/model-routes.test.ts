import type { AgentLoop, AgentProvider } from "@intentic/sandbox-contract/schemas/agent";
import { mintedVariants } from "@intentic/sandbox-contract/models/provider-specs";
import { PROVIDER_VENDOR, TRIAL_ENDPOINT_ID, TRIAL_MODEL_ID } from "@intentic/sandbox-contract/models/agent-catalog";
import type { Services } from "../../../composition.js";
import { services, withTranslator } from "../../../harness/route-services.testing.js";
import { testConfig } from "../../../env.config.testing.js";
import { type ModelRoute, resolveRoute, routeReadiness, routeUrl } from "./model-routes.js";

// Every (provider, loop) pair resolved the way the loop will dial it. Today's Claude Code pairs are pinned to the exact
// credentials the harness carried before the resolver existed; the Codex and OpenCode pairs to the wire and the URL
// each vendor documents for that loop.

const TRANSLATED = { accounts: async () => ({ codex: [{ name: "c.json", label: "c" }], grok: [{ name: "g.json", label: "g" }], kimi: [{ name: "k.json", label: "k" }], gemini: [] }) };

const translated = (): Services => services({ config: withTranslator, cliProxy: TRANSLATED });

const routed = async (sandbox: Services, provider: AgentProvider, loop: AgentLoop, extra: { model?: string; account?: string } = {}): Promise<ModelRoute> => {
    const result = await resolveRoute(sandbox, { provider, loop, ...extra });
    if (!result.ok) {
        throw new Error(`${provider} on ${loop} refused: ${result.message}`);
    }
    return result.route;
};

const refusal = async (sandbox: Services, provider: AgentProvider, loop: AgentLoop): Promise<string> => {
    const result = await resolveRoute(sandbox, { provider, loop });
    if (result.ok) {
        throw new Error(`${provider} on ${loop} resolved, expected a refusal`);
    }
    return result.message;
};

const withEndpoint = async (sandbox: Services, id: string, config: { baseUrl: string; protocol: "openai" | "anthropic"; apiKey?: string; headers?: string }): Promise<Services> => {
    await sandbox.capabilities.upsert({ id, kind: "endpoint", config });
    return sandbox;
};

const endpointCatalog = (models: readonly string[]): Pick<Services, "endpointModels"> => ({
    endpointModels: {
        models: async () => ({ models: models.map((id) => ({ id, label: id, contextWindow: 131_072 })), default: models[0] ?? "" }),
        forget: async () => {},
    },
});

describe("the Claude Code loop, as the harness dialled it before routes", () => {
    test.each(["codex", "grok", "kimi"] as const)("%s rides the translator's root with its bearer and a catalog model", async (provider) => {
        const route = await routed(translated(), provider, "claude-code", { model: "retired" });
        const catalog = await translated().providerCatalogs[provider].models();
        expect(route.wire).toBe("anthropic-messages");
        expect(route.endpoint).toEqual({ base: withTranslator.translator.url, path: "", token: withTranslator.translator.token });
        expect(route.model).toBe(catalog.default);
        expect(route.account).toBeUndefined();
        expect(route.allowance?.vendor).toBe(PROVIDER_VENDOR[provider]);
        expect(route.allowance?.capacity).toBeTypeOf("function");
        expect(route.shield).toBe(provider);
    });

    test("an OpenAI-compatible endpoint rides the translator's entry under its own prefix", async () => {
        const sandbox = await withEndpoint(services({ config: withTranslator, ...endpointCatalog(["qwen3"]) }), "lab", { baseUrl: "http://lab.test/v1", protocol: "openai", apiKey: "owner" });
        const route = await routed(sandbox, "endpoint/lab", "claude-code");
        expect(route.endpoint).toEqual({ base: withTranslator.translator.url, path: "", token: withTranslator.translator.token });
        expect(route.model).toBe("lab/qwen3");
    });

    test("an Anthropic endpoint is dialled straight, its own key and no version segment", async () => {
        const sandbox = await withEndpoint(services({ config: withTranslator, ...endpointCatalog(["m"]) }), "relay", { baseUrl: "https://relay.test/v1", protocol: "anthropic", apiKey: "owner" });
        const route = await routed(sandbox, "endpoint/relay", "claude-code");
        expect(route.endpoint).toEqual({ base: "https://relay.test", path: "", token: "owner" });
        expect(route.via).toBe("endpoint");
    });

    test("the trial is the translator's fixed model, marked as the trial", async () => {
        const sandbox = await withEndpoint(services({ config: withTranslator }), TRIAL_ENDPOINT_ID, { baseUrl: "https://platform.test/trial/v1", protocol: "openai" });
        const route = await routed(sandbox, `endpoint/${TRIAL_ENDPOINT_ID}`, "claude-code");
        expect(route.trial).toBe(true);
        expect(route.model).toBe(`${TRIAL_ENDPOINT_ID}/${TRIAL_MODEL_ID}`);
    });
});

describe("Z.ai on each loop, on the minted key aimed at the estate's own endpoint for that wire", () => {
    test.each((mintedVariants("zai") ?? []).map((variant) => ({ variant })))("$variant.id", async ({ variant }) => {
        const sandbox = services({});
        const { id } = await sandbox.minted.zai.store.connect({ apiKey: "zai-key", variant: variant.id });
        const claude = await routed(sandbox, "zai", "claude-code");
        const codex = await routed(sandbox, "zai", "codex");
        const opencode = await routed(sandbox, "zai", "opencode");
        expect(routeUrl(claude.endpoint)).toBe(variant.anthropicBase);
        expect(codex.wire).toBe("openai-responses");
        expect(routeUrl(codex.endpoint)).toBe(variant.responsesBase ?? "a Responses root");
        expect(opencode.wire).toBe("openai-chat");
        expect(routeUrl(opencode.endpoint)).toBe(variant.catalogBase);
        for (const route of [claude, codex, opencode]) {
            expect(route.endpoint.token).toBe("zai-key");
            expect(route.account).toBe(id);
            expect(route.attribution).toBe(id);
            expect(route.allowance).toEqual({ vendor: "Z.ai" });
        }
    });

    test("a named account that is gone refuses on every loop, rather than running on another", async () => {
        const sandbox = services({});
        await sandbox.minted.zai.store.connect({ apiKey: "zai-key", variant: "zai" });
        for (const loop of ["codex", "opencode"] as const) {
            const result = await resolveRoute(sandbox, { provider: "zai", loop, account: "disconnected" });
            expect(!result.ok && result.message).toContain("no longer connected");
        }
    });
});

describe("Codex as a host, on the Responses wire", () => {
    test.each(["kimi", "grok"] as const)("%s rides the translator's versioned root", async (provider) => {
        const route = await routed(translated(), provider, "codex");
        expect(route.wire).toBe("openai-responses");
        expect(routeUrl(route.endpoint)).toBe(`${withTranslator.translator.url}/v1`);
        expect(route.model).toBe((await translated().providerCatalogs[provider].models()).default);
    });

    test("an OpenAI-compatible endpoint rides the translator's Responses surface for it", async () => {
        const sandbox = await withEndpoint(services({ config: withTranslator, ...endpointCatalog(["qwen3"]) }), "lab", { baseUrl: "http://lab.test/v1", protocol: "openai" });
        const route = await routed(sandbox, "endpoint/lab", "codex");
        expect(routeUrl(route.endpoint)).toBe(`${withTranslator.translator.url}/v1`);
        expect(route.model).toBe("lab/qwen3");
        expect(route.modelRow?.contextWindow).toBe(131_072);
    });

    test("an Anthropic endpoint is refused, since nothing translates it to Responses", async () => {
        const sandbox = await withEndpoint(services({ config: withTranslator, ...endpointCatalog(["m"]) }), "relay", { baseUrl: "https://relay.test", protocol: "anthropic" });
        expect(await refusal(sandbox, "endpoint/relay", "codex")).toContain("Responses");
    });

    test("Meta is not offered here: its key is for Muse Code", async () => {
        const sandbox = services({});
        await sandbox.minted.meta.store.connect({ apiKey: "meta-key", variant: "meta" });
        expect(await refusal(sandbox, "meta", "codex")).toContain("doesn't run on Codex");
    });

    test("no translator sign-in for the provider names what to connect", async () => {
        const sandbox = services({ config: withTranslator });
        expect(await refusal(sandbox, "kimi", "codex")).toBe("Connect your Kimi Code subscription in Sandbox ▸ Agent to run Kimi Code on Codex.");
    });

    test("no translator at all says so for the loop it was asked about", async () => {
        expect(await refusal(services({ config: testConfig, cliProxy: TRANSLATED }), "grok", "codex")).toContain("no model translator");
    });
});

describe("OpenCode as a host", () => {
    test("a ChatGPT plan rides the translator's Responses surface, Kimi its Chat Completions", async () => {
        const chatgpt = await routed(translated(), "codex", "opencode");
        const kimi = await routed(translated(), "kimi", "opencode");
        expect(chatgpt.wire).toBe("openai-responses");
        expect(kimi.wire).toBe("openai-chat");
        for (const route of [chatgpt, kimi]) {
            expect(routeUrl(route.endpoint)).toBe(`${withTranslator.translator.url}/v1`);
        }
    });

    test("an endpoint is dialled straight in its own protocol, key and headers included", async () => {
        const sandbox = services({ config: testConfig, ...endpointCatalog(["qwen3"]) });
        await withEndpoint(sandbox, "lab", { baseUrl: "http://lab.test/api/v2", protocol: "openai", apiKey: "owner", headers: "X-Team: core" });
        await withEndpoint(sandbox, "relay", { baseUrl: "https://relay.test", protocol: "anthropic", apiKey: "owner" });
        const lab = await routed(sandbox, "endpoint/lab", "opencode");
        const relay = await routed(sandbox, "endpoint/relay", "opencode");
        expect(lab).toMatchObject({ wire: "openai-chat", via: "endpoint", model: "qwen3", endpoint: { base: "http://lab.test/api", path: "/v2", token: "owner", headers: { "X-Team": "core" } } });
        expect(relay).toMatchObject({ wire: "anthropic-messages", model: "qwen3", endpoint: { base: "https://relay.test", path: "/v1", token: "owner" } });
    });

    test("Grok and Google stay on OpenCode's own entries, which no route describes", async () => {
        expect(await refusal(translated(), "grok", "opencode")).toContain("doesn't run on OpenCode here");
        expect(await refusal(translated(), "gemini", "opencode")).toContain("doesn't run on OpenCode here");
    });

    test("the free trial runs on Claude Code alone", async () => {
        const sandbox = await withEndpoint(services({ config: withTranslator }), TRIAL_ENDPOINT_ID, { baseUrl: "https://platform.test/trial/v1", protocol: "openai" });
        expect(await refusal(sandbox, `endpoint/${TRIAL_ENDPOINT_ID}`, "opencode")).toContain("doesn't run on");
    });
});

describe("readiness, from what is on file alone", () => {
    test("a pair whose sign-in exists is ready; one whose sign-in nobody made says what to connect", async () => {
        const sandbox = services({ config: withTranslator, cliProxy: { accounts: async () => ({ codex: [{ name: "c.json", label: "c" }], grok: [], kimi: [], gemini: [] }) } });
        expect(await routeReadiness(sandbox, "codex", "opencode")).toEqual({ ready: true });
        expect(await routeReadiness(sandbox, "grok", "codex")).toEqual({ ready: false, detail: "Connect your SuperGrok subscription in Sandbox ▸ Agent to run Grok on Codex." });
    });

    test("a Z.ai key is ready on every loop its estate publishes an endpoint for", async () => {
        const sandbox = services({});
        expect((await routeReadiness(sandbox, "zai", "codex")).ready).toBe(false);
        await sandbox.minted.zai.store.connect({ apiKey: "zai-key", variant: "bigmodel" });
        expect(await routeReadiness(sandbox, "zai", "codex")).toEqual({ ready: true });
        expect(await routeReadiness(sandbox, "zai", "opencode")).toEqual({ ready: true });
    });

    test("an Anthropic endpoint is not ready on Codex, and is on OpenCode", async () => {
        const sandbox = await withEndpoint(services({ config: testConfig }), "relay", { baseUrl: "https://relay.test", protocol: "anthropic" });
        expect((await routeReadiness(sandbox, "endpoint/relay", "codex")).ready).toBe(false);
        expect(await routeReadiness(sandbox, "endpoint/relay", "opencode")).toEqual({ ready: true });
    });
});
