import { expect, test } from "vitest";
import { discoverGeminiModels, humanizeModelId, isChatModel, SEED_GEMINI_MODELS } from "./gemini-models.js";

const jsonResponse = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });

// The translator answers two endpoints per discovery: /v1/models for the channel each id belongs to, and the
// Gemini-shaped /v1beta/models for the vendor's own display names and accepted input modalities.
const translator = (
    models: { id: string; owned_by: string }[],
    published: { name: string; displayName?: string; supportedInputModalities?: string[] }[] = [],
) =>
    (async (url: string | URL, init?: RequestInit) => {
        const target = String(url);
        expect((init?.headers as Record<string, string> | undefined)?.["authorization"]).toBe("Bearer local-bearer");
        if (target.endsWith("/v1beta/models")) {
            return jsonResponse({ models: published });
        }
        // The trailing slash on the configured URL is normalized away.
        expect(target).toBe("http://127.0.0.1:8788/v1/models");
        return jsonResponse({ data: models });
    }) as unknown as typeof fetch;

test("humanizeModelId title-cases the tokens and leaves version segments alone", () => {
    expect(humanizeModelId("gemini-3.1-pro-low")).toBe("Gemini 3.1 Pro Low");
    expect(humanizeModelId("gemini-3-flash")).toBe("Gemini 3 Flash");
});

test("isChatModel drops the image/audio/embedding endpoints the channel ships beside its chat models", () => {
    expect(isChatModel("gemini-pro-agent")).toBe(true);
    expect(isChatModel("claude-opus-4-6-thinking")).toBe(true);
    expect(isChatModel("gemini-3.1-flash-image")).toBe(false);
    expect(isChatModel("imagen-4.0-generate-001")).toBe(false);
});

test("keeps every model the Google channel vends, Claude and GPT-OSS included", async () => {
    // The point of the `owned_by` rule: Antigravity serves Claude Opus and GPT-OSS on the same plain Google
    // sign-in as Gemini, and an id-prefix filter dropped exactly those: the strongest models a free account can
    // reach, while another subscription's models, on a different channel, must still stay out.
    const fake = translator([
        { id: "gemini-pro-agent", owned_by: "antigravity" },
        { id: "claude-opus-4-6-thinking", owned_by: "antigravity" },
        { id: "gpt-oss-120b-medium", owned_by: "antigravity" },
        { id: "gemini-3.1-flash-image", owned_by: "antigravity" },
        { id: "gpt-5.6-sol", owned_by: "openai" },
        { id: "claude-sonnet-4-6", owned_by: "anthropic" },
    ]);

    expect((await discoverGeminiModels("http://127.0.0.1:8788/", "local-bearer", fake)).map((model) => model.id)).toEqual([
        "gemini-pro-agent",
        "claude-opus-4-6-thinking",
        "gpt-oss-120b-medium",
    ]);
});

test("labels a model as its vendor publishes it, since no rule recovers that name from the id", async () => {
    // `gemini-pro-agent` humanizes to "Gemini Pro Agent": a model that does not exist. The translator publishes
    // "Gemini 3.1 Pro (High)", which is what the picker must show.
    const fake = translator(
        [
            { id: "gemini-pro-agent", owned_by: "antigravity" },
            { id: "gemini-3-flash", owned_by: "antigravity" },
        ],
        [{ name: "models/gemini-pro-agent", displayName: "Gemini 3.1 Pro (High)" }],
    );

    expect((await discoverGeminiModels("http://127.0.0.1:8788", "local-bearer", fake)).map((model) => model.label)).toEqual([
        "Gemini 3.1 Pro (High)",
        // An id the name endpoint says nothing about falls back to the humanized form rather than dropping out.
        "Gemini 3 Flash",
    ]);
});

/* THE REGRESSION THAT MADE EVERY GOOGLE MODEL BLIND.
 *
 * The OpenCode runtime registers this channel as a custom provider, so every capability the config omits
 * defaults to false, and a model whose input modalities lack "image" has images stripped out of the request.
 * A user's screenshot never arrived and the model said it could not see it. So discovery has to carry what the
 * translator publishes, per model, rather than leaving the runtime to assume. */
test("carries each model's published input modalities, so the runtime is not left assuming text-only", async () => {
    const fake = translator(
        [
            { id: "claude-opus-4-6-thinking", owned_by: "antigravity" },
            { id: "gemini-pro-agent", owned_by: "antigravity" },
            { id: "gpt-oss-120b-medium", owned_by: "antigravity" },
        ],
        [
            { name: "models/claude-opus-4-6-thinking", supportedInputModalities: ["text", "image"] },
            // "3d" is not a modality OpenCode's config understands; an unknown name is dropped rather than
            // passed through, because one bad word there fails the whole runtime's boot, Grok included.
            { name: "models/gemini-pro-agent", supportedInputModalities: ["text", "image", "audio", "video", "3d"] },
            { name: "models/gpt-oss-120b-medium", supportedInputModalities: ["text"] },
        ],
    );

    expect(await discoverGeminiModels("http://127.0.0.1:8788", "local-bearer", fake)).toEqual([
        { id: "claude-opus-4-6-thinking", label: "Claude Opus 4 6 Thinking", inputModalities: ["text", "image"] },
        { id: "gemini-pro-agent", label: "Gemini Pro Agent", inputModalities: ["text", "image", "audio", "video"] },
        // A text-only model on the channel stays text-only: the point is to publish the truth, not to turn
        // everything on.
        { id: "gpt-oss-120b-medium", label: "Gpt Oss 120b Medium", inputModalities: ["text"] },
    ]);
});

test("a model the channel publishes nothing about is assumed to take images, because the other guess fails silently", async () => {
    // Being wrong toward text-only is invisible: the image vanishes and the model says it cannot see. Being
    // wrong the other way is an upstream rejection the user can read. On this channel images are also the norm.
    const fake = translator([{ id: "kimi-k3", owned_by: "antigravity" }], [{ name: "models/kimi-k3", displayName: "Kimi K3" }]);

    expect(await discoverGeminiModels("http://127.0.0.1:8788", "local-bearer", fake)).toEqual([
        { id: "kimi-k3", label: "Kimi K3", inputModalities: ["text", "image"] },
    ]);
});

test("discoverGeminiModels returns [] on a non-ok response so the caller falls through to seed", async () => {
    const fake = (async () => jsonResponse({ error: "unauthorized" }, 401)) as unknown as typeof fetch;
    expect(await discoverGeminiModels("http://127.0.0.1:8788", "local-bearer", fake)).toEqual([]);
});

test("the seed floor is non-empty and passes its own filter, so a turn always resolves a usable model", () => {
    expect(SEED_GEMINI_MODELS.length).toBeGreaterThan(0);
    expect(SEED_GEMINI_MODELS.every((model) => isChatModel(model.id))).toBe(true);
    // The floor is what a turn runs on before discovery lands, so it has to declare modalities too, or the
    // first turn of a fresh sandbox is the blind one.
    expect(SEED_GEMINI_MODELS.every((model) => model.inputModalities.includes("text"))).toBe(true);
    expect(SEED_GEMINI_MODELS.some((model) => model.inputModalities.includes("image"))).toBe(true);
});
