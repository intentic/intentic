import { expect, test } from "vitest";
import { humanizeModelId, listModels, suggestedModels } from "./model-discovery.js";

const jsonResponse = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });

/* One humanizer for every provider that has to invent a label. It used to be three, and they disagreed about
 * `gpt`: the same id rendered "GPT 5 Codex" under Codex and "Gpt 5 Codex" under the Google channel, which
 * re-serves OpenAI's open-weights models and so shows exactly those ids. */
test("humanizeModelId title-cases the tokens and keeps vendor acronyms upper", () => {
    expect(humanizeModelId("gpt-5-codex")).toBe("GPT 5 Codex");
    expect(humanizeModelId("gpt-oss-120b-medium")).toBe("GPT OSS 120b Medium");
    expect(humanizeModelId("o3-mini")).toBe("O3 Mini");
    expect(humanizeModelId("grok-4-fast")).toBe("Grok 4 Fast");
    expect(humanizeModelId("gemini-3.1-pro-low")).toBe("Gemini 3.1 Pro Low");
    // Dated and dotted segments are the vendor's own and pass through as they are.
    expect(humanizeModelId("grok-4.20-0309-reasoning")).toBe("Grok 4.20 0309 Reasoning");
});

test("listModels reads both the `data` and `models` spellings of an OpenAI-compatible list", async () => {
    const data = (async () => jsonResponse({ data: [{ id: "a", owned_by: "openai" }] })) as unknown as typeof fetch;
    const models = (async () => jsonResponse({ models: [{ id: "b" }] })) as unknown as typeof fetch;
    expect(await listModels("https://example.test/v1/models", "tok", data)).toEqual([{ id: "a", owner: "openai" }]);
    // No `owned_by` means no owner, rather than a made-up one: a single-vendor endpoint has nothing to say here.
    expect(await listModels("https://example.test/v1/language-models", "tok", models)).toEqual([{ id: "b" }]);
});

test("listModels answers [] for every way an endpoint can fail, so the caller can fall to the next rung", async () => {
    const unauthorized = (async () => jsonResponse({ error: "nope" }, 401)) as unknown as typeof fetch;
    const notJson = (async () => new Response("<html>", { status: 200 })) as unknown as typeof fetch;
    const offline = (async () => {
        throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    expect(await listModels("https://example.test", "tok", unauthorized)).toEqual([]);
    expect(await listModels("https://example.test", "tok", notJson)).toEqual([]);
    expect(await listModels("https://example.test", "tok", offline)).toEqual([]);
});

test("suggestedModels reads only the clause after 'did you mean', never the id being rejected", () => {
    const message = "Model `grok-4.20` not found. Did you mean: grok-4.20-reasoning, grok-4.20-multi-agent?";
    expect(suggestedModels(message, /grok[\w.-]+/gi)).toEqual(["grok-4.20-reasoning", "grok-4.20-multi-agent"]);
    expect(suggestedModels("xAI authentication failed", /grok[\w.-]+/gi)).toEqual([]);
});
