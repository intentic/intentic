import { humanizeModelId } from "@intentic/sandbox-contract";
import { idCatalog, listModels, suggestedModels, unrankedCatalog } from "./model-discovery.js";

const jsonResponse = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });

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

test("an unranked set is served frontier first with its head the default, each row kept whole", () => {
    const rows = ["kimi-k2.6", "kimi-k2.7-code-highspeed", "kimi-k3", "kimi-k2.7-code"].map((id) => ({
        id,
        label: id.toUpperCase(),
        efforts: ["low"],
    }));
    const catalog = unrankedCatalog(rows);

    expect(catalog.models.map((row) => row.id)).toEqual(["kimi-k3", "kimi-k2.7-code", "kimi-k2.7-code-highspeed", "kimi-k2.6"]);
    expect(catalog.models[0]).toEqual({ id: "kimi-k3", label: "KIMI-K3", efforts: ["low"] });
    expect(catalog.default).toBe("kimi-k3");
});

test("an empty set has no default rather than an invented one", () => {
    expect(unrankedCatalog([])).toEqual({ models: [], default: "" });
});

test("bare ids read through the contract's labels, in the same order", () => {
    expect(idCatalog(["kimi-k2.6", "kimi-k3"])).toEqual({
        models: [
            { id: "kimi-k3", label: humanizeModelId("kimi-k3") },
            { id: "kimi-k2.6", label: humanizeModelId("kimi-k2.6") },
        ],
        default: "kimi-k3",
    });
});
