import { expect, test } from "vitest";
import { CODEX_MODEL_INVALID, discoverCodexModels, humanizeModelId, isCodexModel, parseCodexModelSuggestions } from "./codex-models.js";

const jsonResponse = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });

test("humanizeModelId uppercases the gpt acronym and title-cases the rest", () => {
    expect(humanizeModelId("gpt-5-codex")).toBe("GPT 5 Codex");
    expect(humanizeModelId("gpt-5.1")).toBe("GPT 5.1");
    expect(humanizeModelId("o3-mini")).toBe("O3 Mini");
    expect(humanizeModelId("codex-mini-latest")).toBe("Codex Mini Latest");
});

test("isCodexModel keeps chat/reasoning/codex families and drops non-chat models", () => {
    expect(isCodexModel("gpt-5.6-sol")).toBe(true); // a future release is kept without a code change
    expect(isCodexModel("gpt-5-codex")).toBe(true);
    expect(isCodexModel("o3")).toBe(true);
    expect(isCodexModel("codex-mini-latest")).toBe(true);
    expect(isCodexModel("gpt-image-1")).toBe(false);
    expect(isCodexModel("text-embedding-3-large")).toBe(false);
    expect(isCodexModel("whisper-1")).toBe(false);
    expect(isCodexModel("gpt-4o-realtime-preview")).toBe(false);
});

test("discoverCodexModels filters OpenAI's /v1/models to chat/codex ids with humanized labels", async () => {
    const fake = (async (url: string | URL) => {
        if (String(url).endsWith("/v1/models")) {
            return jsonResponse({ data: [{ id: "gpt-5.1" }, { id: "gpt-5-codex" }, { id: "text-embedding-3-large" }, { id: "dall-e-3" }] });
        }
        throw new Error(`unexpected call: ${String(url)}`);
    }) as unknown as typeof fetch;
    expect(await discoverCodexModels("tok", fake)).toEqual([
        { id: "gpt-5.1", label: "GPT 5.1" },
        { id: "gpt-5-codex", label: "GPT 5 Codex" },
    ]);
});

test("discoverCodexModels returns [] on a non-ok response so the caller falls through to seed", async () => {
    const fake = (async () => jsonResponse({ error: { message: "unauthorized" } }, 401)) as unknown as typeof fetch;
    expect(await discoverCodexModels("tok", fake)).toEqual([]);
});

test("parseCodexModelSuggestions extracts codex ids after 'Did you mean'", () => {
    expect(parseCodexModelSuggestions("Model not found. Did you mean: gpt-5.1, gpt-5-codex?")).toEqual(["gpt-5.1", "gpt-5-codex"]);
    expect(parseCodexModelSuggestions("The 'gpt-5-codex' model is not supported when using Codex with a ChatGPT account.")).toEqual([]);
});

test("CODEX_MODEL_INVALID matches the ChatGPT-account rejection", () => {
    expect(CODEX_MODEL_INVALID.test("The 'gpt-5-codex' model is not supported when using Codex with a ChatGPT account.")).toBe(true);
    expect(CODEX_MODEL_INVALID.test("rate limit reached")).toBe(false);
});
