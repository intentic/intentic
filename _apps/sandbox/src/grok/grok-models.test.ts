import { expect, test } from "vitest";
import { discoverXaiModels, parseModelSuggestions } from "./grok-models.js";

const jsonResponse = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });

test("parseModelSuggestions extracts the ids after 'Did you mean', not the rejected id", () => {
    const message = "Model not found: xai/grok-code-fast-1. Did you mean: grok-4.20-0309-non-reasoning, grok-4.20-0309-reasoning, grok-4.20-multi-agent-0309?";
    expect(parseModelSuggestions(message)).toEqual(["grok-4.20-0309-non-reasoning", "grok-4.20-0309-reasoning", "grok-4.20-multi-agent-0309"]);
});

test("parseModelSuggestions returns [] when there is no suggestion clause", () => {
    expect(parseModelSuggestions("xAI authentication failed")).toEqual([]);
});

test("discoverXaiModels uses GET /v1/models when it returns data", async () => {
    const fake = (async (url: string | URL) => {
        if (String(url).endsWith("/v1/models")) {
            return jsonResponse({ data: [{ id: "grok-4.20-0309-reasoning" }] });
        }
        throw new Error(`unexpected call: ${String(url)}`);
    }) as unknown as typeof fetch;
    expect(await discoverXaiModels("tok", fake)).toEqual([{ id: "grok-4.20-0309-reasoning", label: "grok-4.20-0309-reasoning" }]);
});

test("discoverXaiModels excludes media-generation models (image/video) from the catalog", async () => {
    const fake = (async (url: string | URL) => {
        if (String(url).endsWith("/v1/models")) {
            return jsonResponse({
                data: [{ id: "grok-imagine-video" }, { id: "grok-2-image-1212" }, { id: "grok-4.20-0309-reasoning" }, { id: "grok-2-vision-1212" }],
            });
        }
        throw new Error(`unexpected call: ${String(url)}`);
    }) as unknown as typeof fetch;
    // The video/image generators drop out; the text chat models (including image-INPUT "vision" chat) stay.
    expect(await discoverXaiModels("tok", fake)).toEqual([
        { id: "grok-4.20-0309-reasoning", label: "grok-4.20-0309-reasoning" },
        { id: "grok-2-vision-1212", label: "grok-2-vision-1212" },
    ]);
});

test("discoverXaiModels falls back to /v1/language-models when /v1/models is empty", async () => {
    const fake = (async (url: string | URL) => {
        if (String(url).endsWith("/v1/models")) return jsonResponse({ data: [] });
        if (String(url).endsWith("/v1/language-models")) return jsonResponse({ models: [{ id: "grok-4.20-multi-agent-0309" }] });
        throw new Error(`unexpected call: ${String(url)}`);
    }) as unknown as typeof fetch;
    expect(await discoverXaiModels("tok", fake)).toEqual([{ id: "grok-4.20-multi-agent-0309", label: "grok-4.20-multi-agent-0309" }]);
});

test("discoverXaiModels probes the chat endpoint and parses 'Did you mean' when the catalogs are empty", async () => {
    const seen: { url: string; method?: string }[] = [];
    const fake = (async (url: string | URL, init?: RequestInit) => {
        seen.push({ url: String(url), method: init?.method });
        if (String(url).endsWith("/v1/models") || String(url).endsWith("/v1/language-models")) {
            return jsonResponse({ data: [] });
        }
        // Chat completions: xAI rejects the throwaway probe model and names the account's valid ones.
        return jsonResponse({ error: { message: "Model not found: intentic-model-probe. Did you mean: grok-4.20-0309-reasoning, grok-4.20-0309-non-reasoning?" } }, 404);
    }) as unknown as typeof fetch;
    expect(await discoverXaiModels("tok", fake)).toEqual([
        { id: "grok-4.20-0309-reasoning", label: "grok-4.20-0309-reasoning" },
        { id: "grok-4.20-0309-non-reasoning", label: "grok-4.20-0309-non-reasoning" },
    ]);
    expect(seen.some((call) => call.url.endsWith("/v1/chat/completions") && call.method === "POST")).toBe(true);
});

test("discoverXaiModels returns [] when nothing yields models", async () => {
    const fake = (async (url: string | URL) => {
        if (String(url).includes("/chat/completions")) return jsonResponse({ error: { message: "internal error" } }, 500);
        return jsonResponse({ data: [] });
    }) as unknown as typeof fetch;
    expect(await discoverXaiModels("tok", fake)).toEqual([]);
});
