import { expect, test } from "vitest";
import {
    CODEX_ADVISORY,
    CODEX_MODEL_INVALID,
    discoverCodexModels,
    discoverTranslatorCodexModels,
    isCodexModel,
    parseCodexModelSuggestions,
} from "./codex-models.js";

const jsonResponse = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });

test("isCodexModel keeps chat/reasoning/codex families and drops non-chat models", () => {
    expect(isCodexModel("gpt-5.6-sol")).toBe(true); // a future release is kept without a code change
    expect(isCodexModel("gpt-5-codex")).toBe(true);
    expect(isCodexModel("o3")).toBe(true);
    expect(isCodexModel("codex-mini-latest")).toBe(true);
    expect(isCodexModel("gpt-image-1")).toBe(false);
    expect(isCodexModel("text-embedding-3-large")).toBe(false);
    expect(isCodexModel("whisper-1")).toBe(false);
    expect(isCodexModel("gpt-4o-realtime-preview")).toBe(false);
    // The CLI's own auto-review model: a role, not a conversation partner.
    expect(isCodexModel("codex-auto-review")).toBe(false);
});

test("keeps only OpenAI-owned rows, because the translator's catalog carries every connected subscription", async () => {
    // The real shape: one endpoint, several vendors. `gpt-oss-120b-medium` is Antigravity re-serving an
    // open-weights model: an id no pattern can tell from OpenAI's own, and one that answers a Codex turn with
    // reasoning and no message at all. Only `owned_by` separates them.
    const fake = (async () =>
        new Response(
            JSON.stringify({
                data: [
                    { id: "gpt-5.6-sol", owned_by: "openai" },
                    { id: "gpt-oss-120b-medium", owned_by: "antigravity" },
                    { id: "claude-sonnet-4-6", owned_by: "antigravity" },
                    { id: "codex-auto-review", owned_by: "openai" },
                ],
            }),
            { status: 200 },
        )) as unknown as typeof fetch;

    expect(await discoverTranslatorCodexModels("http://127.0.0.1:8788", "local-bearer", fake)).toEqual(["gpt-5.6-sol"]);
});

test("discoverCodexModels filters OpenAI's /v1/models to the chat/codex ids", async () => {
    const fake = (async (url: string | URL) => {
        if (String(url).endsWith("/v1/models")) {
            return jsonResponse({ data: [{ id: "gpt-5.1" }, { id: "gpt-5-codex" }, { id: "text-embedding-3-large" }, { id: "dall-e-3" }] });
        }
        throw new Error(`unexpected call: ${String(url)}`);
    }) as unknown as typeof fetch;
    expect(await discoverCodexModels("tok", fake)).toEqual(["gpt-5.1", "gpt-5-codex"]);
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
    expect(CODEX_MODEL_INVALID.test("The model `gpt-5-foo` does not exist or you do not have access to it.")).toBe(true);
    expect(CODEX_MODEL_INVALID.test("model not found")).toBe(true);
    expect(CODEX_MODEL_INVALID.test("rate limit reached")).toBe(false);
});

test("the metadata advisory is a warning, not a rejection: reading it as one would drop a working model", () => {
    // Codex emits this before running the turn perfectly well. It is one careless `not found` away from the
    // self-heal path, which would unpin a model the subscription serves.
    const advisory = "Model metadata for `gpt-5.6-sol` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.";

    expect(CODEX_ADVISORY.test(advisory)).toBe(true);
    expect(CODEX_MODEL_INVALID.test(advisory)).toBe(false);
    expect(CODEX_ADVISORY.test("The 'gpt-5-codex' model is not supported when using Codex with a ChatGPT account.")).toBe(false);
});
