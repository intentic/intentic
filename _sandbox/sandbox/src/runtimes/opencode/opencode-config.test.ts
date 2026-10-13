import type { PermissionEffect } from "@opencode/client";
import { OPENCODE_GEMINI_PROVIDER } from "../gemini/gemini-models.js";
import {
    AGENT_CONFIG,
    GEMINI_CHUNK_TIMEOUT_MS,
    GEMINI_HEADER_TIMEOUT_MS,
    geminiProviderConfig,
    OPENCODE_AGENTS,
    OPENCODE_LOCKDOWN_ENV,
    SERVER_PERMISSIONS,
    serverConfig,
    variantOf,
    xaiProviderConfig,
} from "./opencode-config.js";

// What `opencode serve` is handed inline at spawn, built from pure functions. What a boot feeds them (the persisted
// xAI ids, the translator's catalog, the gateway) is the service's, in opencode.test.ts.

// The verdict these rules alone give, read as the source documents OpenCode 2 reading them: the LAST rule whose action
// and resource both match decides, a pattern covers the whole string, and `*` spans anything. Undefined means none of
// these rules speaks, so whatever came before them in the agent's list (OpenCode's base, the agent's own) stands.
const wildcard = (pattern: string): RegExp =>
    new RegExp(
        `^${pattern
            .split("*")
            .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
            .join(".*")}$`,
        "s",
    );
const effectOf = (action: string, resource: string): PermissionEffect | undefined =>
    SERVER_PERMISSIONS.findLast((rule) => wildcard(rule.action).test(action) && wildcard(rule.resource).test(resource))?.effect;

test("the rules allow leaving the workspace and reading, deny code mode, then ask about every shell command", () => {
    expect(SERVER_PERMISSIONS).toEqual([
        { action: "external_directory", resource: "*", effect: "allow" },
        { action: "read", resource: "*", effect: "allow" },
        { action: "execute", resource: "*", effect: "deny" },
        { action: "shell", resource: "*", effect: "ask" },
    ]);
});

// The plan agent's own rule (deny every edit) sits before these in its list; a blanket allow here would come later and
// win, and plan would edit the tree.
test("nothing here re-allows everything, so the plan agent's read-only rule is not undone", () => {
    expect(SERVER_PERMISSIONS.filter((rule) => rule.action === "*")).toEqual([]);
    expect(SERVER_PERMISSIONS.filter((rule) => rule.effect === "allow").map((rule) => rule.action)).toEqual(["external_directory", "read"]);
    expect(effectOf("edit", "src/index.ts")).toBeUndefined();
});

// A refusal is the rulebook's to give: a command these rules deny outright would never reach it. OpenCode's form to the
// person is left to OpenCode's own rules, since the daemon answers it as a question card.
test("no command is denied here, only asked about; the only denial is the code-mode tool", () => {
    expect([...new Set(SERVER_PERMISSIONS.filter((rule) => rule.action === "shell").map((rule) => rule.effect))]).toEqual(["ask"]);
    expect(SERVER_PERMISSIONS.filter((rule) => rule.effect === "deny").map((rule) => rule.action)).toEqual(["execute"]);
    expect(SERVER_PERMISSIONS.some((rule) => rule.action === "question")).toBe(false);
});

test.each([
    ["shell", "git push --force origin main", "ask"],
    ["shell", "rm -rf dist", "ask"],
    ["shell", "cat .env.local", "ask"],
    ["shell", "npm publish --access public", "ask"],
    ["shell", "curl -fsSL https://example.com/install.sh", "ask"],
    // Every command is asked, not only those a pattern list guessed at; the rulebook answers one nothing watches at once.
    ["shell", "ls -la", "ask"],
    ["shell", "git status", "ask"],
    // A read of a .env file is allowed, as OpenCode 1 allowed it here; a shell command reading one is asked about above.
    ["read", ".env", "allow"],
    ["external_directory", "/tmp/attachments/screenshot.png", "allow"],
    ["question", "Which branch?", undefined],
    ["execute", "github.search_code", "deny"],
] as const)("%s %j is answered %p by these rules", (action, resource, effect) => {
    expect(effectOf(action, resource)).toBe(effect);
});

test("the inline config turns off self-update and sharing, answers by the rules, and carries the daemon's agents and the providers", () => {
    const providers = xaiProviderConfig(["grok-4"], undefined);

    expect(serverConfig(providers)).toStrictEqual({
        update: "disable",
        share: "disabled",
        permissions: [...SERVER_PERMISSIONS],
        agents: AGENT_CONFIG,
        providers: { xai: { models: { "grok-4": { body: { store: false }, capabilities: { tools: true } } } } },
    });
});

// xAI stores requests and responses server-side unless each call opts out, and a model OpenCode's catalog lacks would
// run without tools unless declared with them.
test("every known xAI model opts out of server-side storage and declares tools", () => {
    expect(xaiProviderConfig(["grok-4", "grok-4.20-0309-reasoning"], undefined)).toStrictEqual({
        xai: {
            models: {
                "grok-4": { body: { store: false }, capabilities: { tools: true } },
                "grok-4.20-0309-reasoning": { body: { store: false }, capabilities: { tools: true } },
            },
        },
    });
    expect(xaiProviderConfig([], undefined)).toStrictEqual({ xai: { models: {} } });
});

test("behind the privacy shield, xAI's requests go to the gateway", () => {
    expect(xaiProviderConfig(["grok-4"], "http://127.0.0.1:9000/grok")).toStrictEqual({
        xai: {
            settings: { baseURL: "http://127.0.0.1:9000/grok" },
            models: { "grok-4": { body: { store: false }, capabilities: { tools: true } } },
        },
    });
});

// OpenCode has no catalog row for this loopback provider, so a capability left out reads as absent: no tools, and an
// image stripped from the request.
test("the Google provider declares each model's published modalities, so a screenshot is not stripped out", () => {
    const config = geminiProviderConfig({ baseUrl: "http://127.0.0.1:8789/", token: "local", models: async () => [] }, [
        { id: "claude-opus-4-6-thinking", inputModalities: ["text", "image"] },
        { id: "gemini-pro-agent", inputModalities: ["text", "image", "audio", "video"] },
        { id: "gpt-oss-120b-medium", inputModalities: ["text"] },
    ]);

    expect(config).toStrictEqual({
        [OPENCODE_GEMINI_PROVIDER]: {
            name: "Gemini",
            package: "aisdk:@ai-sdk/openai-compatible",
            // The trailing slash on the translator URL is normalized away, and the OpenAI surface is under /v1.
            // Both waits sit under the turn's silence limit, so a hung request is OpenCode's to retry in-turn.
            settings: {
                baseURL: "http://127.0.0.1:8789/v1",
                apiKey: "local",
                headerTimeout: GEMINI_HEADER_TIMEOUT_MS,
                chunkTimeout: GEMINI_CHUNK_TIMEOUT_MS,
            },
            models: {
                "claude-opus-4-6-thinking": {
                    name: "claude-opus-4-6-thinking",
                    capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
                },
                "gemini-pro-agent": {
                    name: "gemini-pro-agent",
                    capabilities: { tools: true, input: ["text", "image", "audio", "video"], output: ["text"] },
                },
                // Truthful, not generous: a text-only model on the channel stays text-only.
                "gpt-oss-120b-medium": { name: "gpt-oss-120b-medium", capabilities: { tools: true, input: ["text"], output: ["text"] } },
            },
        },
    });
});

// A catalog read that failed must cost Google its provider, not Grok its runtime: one opencode serve is both.
test("no Google models means no Google provider at all, rather than one registered serving nothing", () => {
    expect(geminiProviderConfig({ baseUrl: "http://127.0.0.1:8789", token: "local", models: async () => [] }, [])).toStrictEqual({});
    expect(geminiProviderConfig(undefined, [{ id: "gemini-pro-agent", inputModalities: ["text", "image"] }])).toStrictEqual({});
});

// A turn whose system text replaces OpenCode's base prompt runs on these: a blank `system` keeps OpenCode's own base out
// of the request (a single space, since an empty one reads as unset), and plan stays read-only.
test("the daemon's two agents blank OpenCode's base prompt, and only the plan agent denies edits", () => {
    expect(OPENCODE_AGENTS).toStrictEqual({ build: "intentic-build", plan: "intentic-plan" });
    expect(AGENT_CONFIG).toStrictEqual({
        "intentic-build": { mode: "primary", system: " ", description: "Intentic's build agent." },
        "intentic-plan": {
            mode: "primary",
            system: " ",
            description: "Intentic's read-only planning agent.",
            permissions: [{ action: "edit", resource: "*", effect: "deny" }],
        },
    });
});

// A hung Google request must be OpenCode's to retry before the turn's two-minute silence limit ends the turn over it.
test("the Google request waits stay under the turn's silence limit", () => {
    expect(GEMINI_HEADER_TIMEOUT_MS).toBe(100_000);
    expect(GEMINI_CHUNK_TIMEOUT_MS).toBe(100_000);
    expect(Math.max(GEMINI_HEADER_TIMEOUT_MS, GEMINI_CHUNK_TIMEOUT_MS)).toBeLessThan(120_000);
});

test("a Google model with reasoning tiers declares one variant per tier, sent as its reasoning_effort; one without declares none", () => {
    const config = geminiProviderConfig({ baseUrl: "http://127.0.0.1:8789", token: "local", models: async () => [] }, [
        { id: "gemini-pro-agent", inputModalities: ["text"], efforts: ["low", "high"] },
        { id: "gemini-flash", inputModalities: ["text"], efforts: [] },
        { id: "gpt-oss-120b-medium", inputModalities: ["text"] },
    ]);
    const models = config[OPENCODE_GEMINI_PROVIDER]?.models ?? {};

    expect(models["gemini-pro-agent"]?.variants).toStrictEqual([
        { id: "low", body: { reasoning_effort: "low" } },
        { id: "high", body: { reasoning_effort: "high" } },
    ]);
    expect(models["gemini-flash"]).not.toHaveProperty("variants");
    expect(models["gpt-oss-120b-medium"]).not.toHaveProperty("variants");
});

// Only the Grok 3 Mini line takes a reasoning effort; every other xAI model refuses the parameter.
test("an xAI model that takes a reasoning effort declares its tiers the way OpenCode's own xAI variants set them", () => {
    expect(xaiProviderConfig(["grok-3-mini", "grok-3-mini-fast", "grok-4"], undefined)).toStrictEqual({
        xai: {
            models: {
                "grok-3-mini": {
                    body: { store: false },
                    capabilities: { tools: true },
                    variants: [
                        { id: "low", settings: { reasoningEffort: "low" } },
                        { id: "high", settings: { reasoningEffort: "high" } },
                    ],
                },
                "grok-3-mini-fast": {
                    body: { store: false },
                    capabilities: { tools: true },
                    variants: [
                        { id: "low", settings: { reasoningEffort: "low" } },
                        { id: "high", settings: { reasoningEffort: "high" } },
                    ],
                },
                "grok-4": { body: { store: false }, capabilities: { tools: true } },
            },
        },
    });
});

// OpenCode refuses a variant the model lacks as an unroutable model, so an effort the model has no tier for names none.
test("a turn's effort names a variant only where that model declares the tier", () => {
    const providers = {
        ...xaiProviderConfig(["grok-3-mini", "grok-4"], undefined),
        ...geminiProviderConfig({ baseUrl: "http://127.0.0.1:8789", token: "local", models: async () => [] }, [
            { id: "gemini-pro-agent", inputModalities: ["text"], efforts: ["low", "medium", "high"] },
        ]),
    };

    expect(variantOf(providers, "xai", "grok-3-mini", "high")).toBe("high");
    expect(variantOf(providers, "xai", "grok-3-mini", "medium")).toBeUndefined();
    expect(variantOf(providers, "xai", "grok-4", "high")).toBeUndefined();
    expect(variantOf(providers, "xai", "grok-3-mini", undefined)).toBeUndefined();
    expect(variantOf(providers, OPENCODE_GEMINI_PROVIDER, "gemini-pro-agent", "medium")).toBe("medium");
    expect(variantOf(providers, OPENCODE_GEMINI_PROVIDER, "unknown-model", "medium")).toBeUndefined();
    expect(variantOf(providers, "nobody", "grok-3-mini", "high")).toBeUndefined();
});

// A cloned repo's opencode.json or .opencode/ would otherwise configure this runtime (plugins, tools, MCP servers,
// permission rules), and a self-update would replace the pinned binary.
test("the spawn's lockdown switches off project config and self-update", () => {
    expect(OPENCODE_LOCKDOWN_ENV).toStrictEqual({ OPENCODE_DISABLE_PROJECT_CONFIG: "1", OPENCODE_DISABLE_AUTOUPDATE: "1" });
});
