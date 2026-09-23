import { unstubbed } from "@intentic/testing";
import { test, expect } from "bun:test";
import type { Services } from "../../composition.js";
import { context, servicesWith, turn } from "../../agent/run/turn/turn-plan.testing.js";
import { testConfig } from "../../testing.js";
import { planGeminiTurn } from "./gemini-provider.js";
import type { GeminiModel } from "./gemini-models.js";

// What the Google channel does with the model a turn names. The channel vends one row per model AND per thinking level
// (Claude Opus beside Gemini Pro), each metered on its own allowance, so which id is sent is not a detail: substituting
// spends a different allowance than the one the user chose.

const OFFERED: readonly GeminiModel[] = [
    { id: "claude-opus-4-6-thinking", label: "Claude Opus 4.6 (Thinking)", inputModalities: ["text", "image"] },
    { id: "gemini-3.1-pro-low", label: "Gemini 3.1 Pro (Low)", inputModalities: ["text", "image"] },
];

// `live` undefined is a translator that has never listed a Google model, while `models` still falls back to the seed.
const geminiServices = (models: readonly GeminiModel[] = OFFERED, served: { live: readonly GeminiModel[] | undefined } = { live: models }): Services =>
    servicesWith({
        config: { ...testConfig, translator: { url: "http://127.0.0.1:8788", token: "local" } },
        cliProxy: unstubbed<Services["cliProxy"]>("cliProxy", {
            accounts: async () => ({ codex: [], grok: [], kimi: [], gemini: [{ name: "google", label: "google" }] }),
        }),
        geminiModels: unstubbed<Services["geminiModels"]>("geminiModels", {
            models: async () => ({ models: [...models], default: models[0]?.id ?? "" }),
            live: async () => served.live,
        }),
        async *geminiAgent() {},
    });

test("sends the pinned model the channel offers", async () => {
    const plan = await planGeminiTurn(geminiServices(), turn({ model: "gemini-3.1-pro-low" }), context);

    expect(plan).toMatchObject({ ok: true, request: { spec: { model: "gemini-3.1-pro-low" } } });
});

test("opens on the catalog default when the turn names no model, empty id included", async () => {
    // The wire allows `model: ""` and means the same as absent; both are "whatever this channel leads with".
    for (const model of [undefined, ""]) {
        const plan = await planGeminiTurn(geminiServices(), turn({ model }), context);

        expect(plan).toMatchObject({ ok: true, request: { spec: { model: "claude-opus-4-6-thinking" } } });
    }
});

test("refuses a pin the channel has stopped offering instead of running on the catalog default", async () => {
    // Opus de-listed, as the channel does while it is out of capacity for it; the catalog's own grace window has run
    // out by the time a plan sees a list without it.
    const plan = await planGeminiTurn(geminiServices([OFFERED[1]!]), turn({ model: "claude-opus-4-6-thinking" }), context);

    expect(plan).toEqual({
        ok: false,
        code: "model-unavailable",
        message:
            "Google is no longer offering claude-opus-4-6-thinking, and this chat is pinned to it. " +
            "Pick another model for this chat, or send again if it comes back.",
    });
});

test("refuses a turn the translator has no Google model to serve, instead of sending it to fail as unknown", async () => {
    // A connected account the translator cannot use (not loaded, or switched off): the picker still shows the seed.
    const plan = await planGeminiTurn(geminiServices(OFFERED, { live: undefined }), turn({ model: "claude-opus-4-6-thinking" }), context);

    expect(plan).toEqual({
        ok: false,
        message:
            "Google is connected, but the model translator isn't serving any Google model to this sandbox, so nothing can run on it. " +
            "Send again in a minute; if it keeps happening, reconnect Google in Sandbox ▸ Agent.",
    });
});
