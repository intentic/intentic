import { expect, test } from "vitest";
import { discoverKimiModels, humanizeModelId, isChatModel, MOONSHOT_ANTHROPIC_BASE, SEED_KIMI_MODELS } from "./kimi-models.js";

const jsonResponse = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });

test("humanizeModelId uppercases the k2 family tag and title-cases the rest", () => {
    expect(humanizeModelId("kimi-k2-0711-preview")).toBe("Kimi K2 0711 Preview");
    expect(humanizeModelId("kimi-k2-turbo-preview")).toBe("Kimi K2 Turbo Preview");
    expect(humanizeModelId("kimi-latest")).toBe("Kimi Latest");
});

test("isChatModel keeps kimi/moonshot chat families and drops non-chat models", () => {
    expect(isChatModel("kimi-k2-0711-preview")).toBe(true);
    expect(isChatModel("moonshot-v1-128k")).toBe(true);
    expect(isChatModel("kimi-embedding-1")).toBe(false);
    expect(isChatModel("gpt-4o")).toBe(false); // a foreign id never leaks into the Kimi catalog
});

test("discoverKimiModels filters Moonshot's /v1/models to chat ids with humanized labels", async () => {
    const fake = (async (url: string | URL) => {
        if (String(url).endsWith("/v1/models")) {
            return jsonResponse({ data: [{ id: "kimi-k2-0711-preview" }, { id: "kimi-k2-turbo-preview" }, { id: "kimi-embedding-1" }] });
        }
        throw new Error(`unexpected call: ${String(url)}`);
    }) as unknown as typeof fetch;
    expect(await discoverKimiModels("tok", fake)).toEqual([
        { id: "kimi-k2-0711-preview", label: "Kimi K2 0711 Preview" },
        { id: "kimi-k2-turbo-preview", label: "Kimi K2 Turbo Preview" },
    ]);
});

test("discoverKimiModels returns [] on a non-ok response so the caller falls through to seed", async () => {
    const fake = (async () => jsonResponse({ error: { message: "unauthorized" } }, 401)) as unknown as typeof fetch;
    expect(await discoverKimiModels("tok", fake)).toEqual([]);
});

test("the seed floor is non-empty and the Anthropic base is Moonshot's, so a turn always resolves", () => {
    expect(SEED_KIMI_MODELS.length).toBeGreaterThan(0);
    expect(MOONSHOT_ANTHROPIC_BASE).toContain("moonshot");
    expect(MOONSHOT_ANTHROPIC_BASE).toContain("anthropic");
});
