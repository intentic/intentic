import { unstubbed } from "@intentic/testing";
import { expect, test } from "vitest";
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

const geminiServices = (models: readonly GeminiModel[] = OFFERED): Services =>
    servicesWith({
        config: { ...testConfig, translator: { url: "http://127.0.0.1:8788", token: "local" } },
        cliProxy: unstubbed<Services["cliProxy"]>("cliProxy", {
            accounts: async () => ({ codex: [], grok: [], kimi: [], gemini: [{ name: "google", label: "google" }] }),
        }),
        geminiModels: unstubbed<Services["geminiModels"]>("geminiModels", {
            models: async () => ({ models: [...models], default: models[0]?.id ?? "" }),
        }),
        async *geminiAgent() {},
    });

test("sends the pinned model the channel offers", async () => {
    const plan = await planGeminiTurn(geminiServices(), turn({ model: "gemini-3.1-pro-low" }), context);

    expect(plan).toMatchObject({ ok: true, request: { model: "gemini-3.1-pro-low" } });
});

test("opens on the catalog default when the turn names no model, empty id included", async () => {
    // The wire allows `model: ""` and means the same as absent; both are "whatever this channel leads with".
    for (const model of [undefined, ""]) {
        const plan = await planGeminiTurn(geminiServices(), turn({ model }), context);

        expect(plan).toMatchObject({ ok: true, request: { model: "claude-opus-4-6-thinking" } });
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
