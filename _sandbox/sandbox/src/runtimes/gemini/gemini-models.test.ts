import { humanizeModelId } from "@intentic/sandbox-contract";
import { advanceTimersByTimeAsync } from "@intentic/testing/bun";
import { discoverGeminiModels, isChatModel, SEED_GEMINI_MODELS } from "./gemini-models.js";

const jsonResponse = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });

// Fakes the translator's two discovery endpoints: /v1/models (which channel each id belongs to) and /v1beta/models
// (Gemini's own display names and modalities).
const translator = (
    models: { id: string; owned_by: string }[],
    published: { name: string; displayName?: string; supportedInputModalities?: string[] }[] = [],
) =>
    Object.assign(
        async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
            const target = String(url);
            expect(new Headers(init?.headers).get("authorization")).toBe("Bearer local-bearer");
            if (target.endsWith("/v1beta/models")) {
                return jsonResponse({ models: published });
            }
            // Trailing slash on the configured URL is normalized away.
            expect(target).toBe("http://127.0.0.1:8788/v1/models");
            return jsonResponse({ data: models });
        },
        { preconnect: () => undefined },
    );

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
    const fake = translator([
        { id: "gemini-pro-agent", owned_by: "antigravity" },
        { id: "claude-opus-4-6-thinking", owned_by: "antigravity" },
        { id: "claude-opus-5-5-high", owned_by: "antigravity" },
        { id: "gpt-oss-120b-medium", owned_by: "antigravity" },
        { id: "gemini-3.1-flash-image", owned_by: "antigravity" },
        { id: "gpt-5.6-sol", owned_by: "openai" },
        { id: "claude-sonnet-4-6", owned_by: "anthropic" },
    ]);

    expect((await discoverGeminiModels("http://127.0.0.1:8788/", "local-bearer", fake))?.map((model) => model.id)).toEqual([
        "gemini-pro-agent",
        "claude-opus-4-6-thinking",
        "claude-opus-5-5-high",
        "gpt-oss-120b-medium",
    ]);
});

test("labels a model as its vendor publishes it, since no rule recovers that name from the id", async () => {
    // gemini-pro-agent humanizes to a model that doesn't exist; the translator's own display name is what shows.
    const fake = translator(
        [
            { id: "gemini-pro-agent", owned_by: "antigravity" },
            { id: "gemini-3-flash", owned_by: "antigravity" },
        ],
        [{ name: "models/gemini-pro-agent", displayName: "Gemini 3.1 Pro (High)" }],
    );

    expect((await discoverGeminiModels("http://127.0.0.1:8788", "local-bearer", fake))?.map((model) => model.label)).toEqual([
        "Gemini 3.1 Pro (High)",
        // Unpublished id falls back to the humanized form rather than dropping out.
        "Gemini 3 Flash",
    ]);
});

// OpenCode registers this channel as a custom provider: an omitted capability defaults to false, so a model whose
// modalities lack "image" has images stripped from the request.
test("carries each model's published input modalities, so the runtime is not left assuming text-only", async () => {
    const fake = translator(
        [
            { id: "claude-opus-4-6-thinking", owned_by: "antigravity" },
            { id: "gemini-pro-agent", owned_by: "antigravity" },
            { id: "gpt-oss-120b-medium", owned_by: "antigravity" },
        ],
        [
            { name: "models/claude-opus-4-6-thinking", supportedInputModalities: ["text", "image"] },
            // Unknown modality names are dropped, not passed through: one bad word here fails the whole runtime's boot.
            { name: "models/gemini-pro-agent", supportedInputModalities: ["text", "image", "audio", "video", "3d"] },
            { name: "models/gpt-oss-120b-medium", supportedInputModalities: ["text"] },
        ],
    );

    expect(await discoverGeminiModels("http://127.0.0.1:8788", "local-bearer", fake)).toEqual([
        { id: "claude-opus-4-6-thinking", label: "Claude Opus 4.6 Thinking", inputModalities: ["text", "image"] },
        { id: "gemini-pro-agent", label: "Gemini Pro Agent", inputModalities: ["text", "image", "audio", "video"] },
        { id: "gpt-oss-120b-medium", label: "GPT OSS 120b Medium", inputModalities: ["text"] },
    ]);
});

test("a model the channel publishes nothing about is assumed to take images, because the other guess fails silently", async () => {
    const fake = translator([{ id: "kimi-k3", owned_by: "antigravity" }], [{ name: "models/kimi-k3", displayName: "Kimi K3" }]);

    expect(await discoverGeminiModels("http://127.0.0.1:8788", "local-bearer", fake)).toEqual([
        { id: "kimi-k3", label: "Kimi K3", inputModalities: ["text", "image"] },
    ]);
});

test("parses optional display JSON without trusting malformed labels or modality entries", async () => {
    const fake = Object.assign(
        async (url: Parameters<typeof fetch>[0]) =>
            jsonResponse(
                String(url).endsWith("/v1beta/models")
                    ? {
                          models: [
                              null,
                              { name: 123 },
                              { name: "models/gemini-pro-agent", displayName: 123, supportedInputModalities: ["text", "image", "3d", 123] },
                          ],
                      }
                    : { data: [{ id: "gemini-pro-agent", owned_by: "antigravity" }] },
            ),
        { preconnect: () => undefined },
    );
    expect(await discoverGeminiModels("http://127.0.0.1:8788", "local-bearer", fake)).toEqual([
        { id: "gemini-pro-agent", label: "Gemini Pro Agent", inputModalities: ["text", "image"] },
    ]);
});

test("an unreadable advertisement is unknown, not an authoritative empty catalog", async () => {
    const fake = Object.assign(async () => jsonResponse({ error: "unauthorized" }, 401), { preconnect: () => undefined });
    expect(await discoverGeminiModels("http://127.0.0.1:8788", "local-bearer", fake)).toBe(undefined);
});

test("a successful empty advertisement is distinct from a failed read", async () => {
    expect(await discoverGeminiModels("http://127.0.0.1:8788", "local-bearer", translator([]))).toEqual([]);
});

test.each([{ data: {} }, {}, { data: [null] }, { data: [{ owned_by: "antigravity" }] }])(
    "a malformed advertisement remains unknown: %j",
    async (body) => {
        const fake = Object.assign(async () => jsonResponse(body), { preconnect: () => undefined });
        expect(await discoverGeminiModels("http://127.0.0.1:8788", "local-bearer", fake)).toBe(undefined);
    },
);

test("bounds and cancels a stalled advertisement read", async () => {
    jest.useFakeTimers();
    const signals: AbortSignal[] = [];
    const fake = Object.assign(
        async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
            new Promise<Response>((_resolve, reject) => {
                const signal = init?.signal;
                if (signal === undefined || signal === null) {
                    throw new Error("discovery omitted its cancellation signal");
                }
                signals.push(signal);
                signal.addEventListener("abort", () => reject(new Error("request aborted")), { once: true });
            }),
        { preconnect: () => undefined },
    );
    try {
        const result = discoverGeminiModels("http://127.0.0.1:8788", "local-bearer", fake);
        await advanceTimersByTimeAsync(8_000);
        expect(await result).toBe(undefined);
        expect(signals.map((signal) => signal.aborted)).toEqual([true, true]);
    } finally {
        jest.useRealTimers();
    }
});

test("the display seed is non-empty and declares chat models' input modalities", () => {
    expect(SEED_GEMINI_MODELS.length).toBeGreaterThan(0);
    expect(SEED_GEMINI_MODELS.every((model) => isChatModel(model.id))).toBe(true);
    // Even fallback display metadata keeps modalities; eligibility is verified separately before a turn can run.
    expect(SEED_GEMINI_MODELS.every((model) => model.inputModalities.includes("text"))).toBe(true);
    expect(SEED_GEMINI_MODELS.some((model) => model.inputModalities.includes("image"))).toBe(true);
});
