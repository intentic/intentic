import { expect, test } from "vitest";
import { discoverGeminiModels, humanizeModelId, isGeminiModel, SEED_GEMINI_MODELS } from "./gemini-models.js";

const jsonResponse = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });

test("humanizeModelId title-cases the tokens and leaves version segments alone", () => {
    expect(humanizeModelId("gemini-3.1-pro-low")).toBe("Gemini 3.1 Pro Low");
    expect(humanizeModelId("gemini-pro-agent")).toBe("Gemini Pro Agent");
    expect(humanizeModelId("gemini-3-flash")).toBe("Gemini 3 Flash");
});

test("isGeminiModel keeps Google's chat families and drops non-chat and foreign ids", () => {
    expect(isGeminiModel("gemini-pro-agent")).toBe(true);
    expect(isGeminiModel("gemini-3.1-flash-lite")).toBe(true);
    expect(isGeminiModel("gemini-3.1-flash-image")).toBe(false);
    expect(isGeminiModel("imagen-4.0-generate-001")).toBe(false);
    // The translator serves every connected upstream behind ONE /v1/models, so the filter is what keeps
    // another provider's subscription out of the Gemini picker.
    expect(isGeminiModel("claude-sonnet-4-6")).toBe(false);
    expect(isGeminiModel("gpt-5.5")).toBe(false);
});

test("discoverGeminiModels filters the translator's /v1/models to Gemini chat ids with humanized labels", async () => {
    let seen: { url: string; auth: string | undefined } | undefined;
    const fake = (async (url: string | URL, init?: RequestInit) => {
        seen = { url: String(url), auth: (init?.headers as Record<string, string> | undefined)?.authorization };
        return jsonResponse({
            data: [{ id: "gemini-pro-agent" }, { id: "claude-sonnet-4-6" }, { id: "gemini-3-flash" }, { id: "gemini-3.1-flash-image" }],
        });
    }) as unknown as typeof fetch;
    expect(await discoverGeminiModels("http://127.0.0.1:8788/", "local-bearer", fake)).toEqual([
        { id: "gemini-pro-agent", label: "Gemini Pro Agent" },
        { id: "gemini-3-flash", label: "Gemini 3 Flash" },
    ]);
    // The trailing slash is normalized away, and the translator's own local bearer is what reads its catalog.
    expect(seen).toEqual({ url: "http://127.0.0.1:8788/v1/models", auth: "Bearer local-bearer" });
});

test("discoverGeminiModels returns [] on a non-ok response so the caller falls through to seed", async () => {
    const fake = (async () => jsonResponse({ error: "unauthorized" }, 401)) as unknown as typeof fetch;
    expect(await discoverGeminiModels("http://127.0.0.1:8788", "local-bearer", fake)).toEqual([]);
});

test("the seed floor is non-empty and passes its own filter, so a turn always resolves a usable model", () => {
    expect(SEED_GEMINI_MODELS.length).toBeGreaterThan(0);
    expect(SEED_GEMINI_MODELS.every(isGeminiModel)).toBe(true);
});
