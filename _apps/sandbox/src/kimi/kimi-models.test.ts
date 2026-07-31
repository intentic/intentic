import { expect, test } from "vitest";
import { discoverKimiModels, humanizeModelId, isChatModel, MOONSHOT_ANTHROPIC_BASE, SEED_KIMI_MODELS } from "./kimi-models.js";

const jsonResponse = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });

test("humanizeModelId uppercases Kimi's generation tag and title-cases the rest", () => {
    expect(humanizeModelId("kimi-k3")).toBe("Kimi K3");
    expect(humanizeModelId("kimi-k2.7-code")).toBe("Kimi K2.7 Code");
    expect(humanizeModelId("kimi-k2-0711-preview")).toBe("Kimi K2 0711 Preview");
    expect(humanizeModelId("kimi-latest")).toBe("Kimi Latest");
});

test("isChatModel keeps kimi/moonshot chat families and drops non-chat models", () => {
    expect(isChatModel("kimi-k3")).toBe(true);
    expect(isChatModel("kimi-k2-0711-preview")).toBe(true);
    expect(isChatModel("moonshot-v1-128k")).toBe(true);
    expect(isChatModel("kimi-embedding-1")).toBe(false);
    expect(isChatModel("gpt-4o")).toBe(false); // a foreign id never leaks into the Kimi catalog
});

test("discoverKimiModels filters Moonshot's /v1/models to chat ids with humanized labels", async () => {
    const fake = (async (url: string | URL) => {
        if (String(url).endsWith("/v1/models")) {
            return jsonResponse({ data: [{ id: "kimi-k3" }, { id: "kimi-k2.7-code" }, { id: "kimi-embedding-1" }] });
        }
        throw new Error(`unexpected call: ${String(url)}`);
    }) as unknown as typeof fetch;
    expect(await discoverKimiModels("tok", fake)).toEqual([
        { id: "kimi-k3", label: "Kimi K3" },
        { id: "kimi-k2.7-code", label: "Kimi K2.7 Code" },
    ]);
});

test("discoverKimiModels returns [] on a non-ok response so the caller falls through to seed", async () => {
    const fake = (async () => jsonResponse({ error: { message: "unauthorized" } }, 401)) as unknown as typeof fetch;
    expect(await discoverKimiModels("tok", fake)).toEqual([]);
});

test("the seed floor starts on K3 and contains no discontinued K2 preview ids", () => {
    expect(SEED_KIMI_MODELS[0]).toBe("kimi-k3");
    expect(SEED_KIMI_MODELS.some((id) => /kimi-k2-(?:0711|0905|turbo)/.test(id))).toBe(false);
    expect(SEED_KIMI_MODELS.every(isChatModel)).toBe(true);
});

test("the Anthropic base is Moonshot's, so a turn uses the supported compatibility endpoint", () => {
    expect(MOONSHOT_ANTHROPIC_BASE).toContain("moonshot");
    expect(MOONSHOT_ANTHROPIC_BASE).toContain("anthropic");
});
