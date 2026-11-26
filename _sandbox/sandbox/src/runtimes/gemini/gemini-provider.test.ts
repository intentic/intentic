import { unstubbed } from "@intentic/testing";
import type { Services } from "../../composition.js";
import { context, servicesWith, turn } from "../../agent/run/turn/turn-plan.testing.js";
import { testConfig } from "../../env.config.testing.js";
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
const geminiServices = (
    models: readonly GeminiModel[] = OFFERED,
    served: { live: readonly GeminiModel[] | undefined } = { live: models },
    overrides: Partial<Services> = {},
): Services =>
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
        // The daemon's own servers ride every planned turn (daemon-tools/door-tools.ts); the deps server names its conversation.
        agents: unstubbed<Services["agents"]>("agents", { entry: () => undefined }),
        ...overrides,
    });

test("sends the pinned model the channel offers", async () => {
    const plan = await planGeminiTurn(geminiServices(), turn({ model: "gemini-3.1-pro-low" }), context, []);

    expect(plan).toMatchObject({ ok: true, request: { spec: { model: "gemini-3.1-pro-low" } } });
});

test("opens on the catalog default when the turn names no model, empty id included", async () => {
    // The wire allows `model: ""` and means the same as absent; both are "whatever this channel leads with".
    for (const model of [undefined, ""]) {
        const plan = await planGeminiTurn(geminiServices(), turn({ model }), context, []);

        expect(plan).toMatchObject({ ok: true, request: { spec: { model: "claude-opus-4-6-thinking" } } });
    }
});

test("refuses a pin the channel has stopped offering instead of running on the catalog default", async () => {
    // Opus de-listed, as the channel does while it is out of capacity for it; the catalog's own grace window has run
    // out by the time a plan sees a list without it.
    const plan = await planGeminiTurn(geminiServices([OFFERED[1]!]), turn({ model: "claude-opus-4-6-thinking" }), context, []);

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
    const plan = await planGeminiTurn(geminiServices(OFFERED, { live: undefined }), turn({ model: "claude-opus-4-6-thinking" }), context, []);

    expect(plan).toEqual({
        ok: false,
        message:
            "Google is connected, but the model translator isn't serving any Google model to this sandbox, so nothing can run on it. " +
            "Send again in a minute; if it keeps happening, reconnect Google in Sandbox ▸ Agent.",
    });
});

// Gemini rides OpenCode: the turn's leased mounts are forwarded, followed by the daemon's own servers.
test("hands the turn its remote MCP servers, the linked sandbox first and the daemon's own after", async () => {
    const link = { name: "linked", url: "http://127.0.0.1:8787/mcp/linked", token: "turn-bearer", timeoutMs: 120_000 };
    const services = geminiServices(OFFERED, { live: OFFERED }, { linkMounts: () => [link] });

    const plan = await planGeminiTurn(services, turn({ model: "gemini-3.1-pro-low", conversationId: "chat-1" }), context, []);
    if (!plan.ok) {
        throw new Error(`planning refused the turn: ${plan.message}`);
    }

    const remote = plan.request.tools.remote ?? [];
    expect(remote[0]).toEqual(link);
    expect(remote.map((tool) => tool.name)).toEqual(expect.arrayContaining(["ui", "subagents", "watch"]));
    expect(plan.request.hooks.relay).toMatchObject({ attach: expect.any(Function), push: expect.any(Function) });
});

// A helper's request reads nothing past its prompt, so it never leases the turn's tools.
test("a sealed request is handed no MCP server, on the model it pinned", async () => {
    const lease = jest.fn(() => {
        throw new Error("a sealed turn requested a tool lease");
    });
    const services = geminiServices(OFFERED, { live: OFFERED }, { turnMounts: unstubbed<Services["turnMounts"]>("turnMounts", { lease }) });
    const sealed = { ...context, base: { ...context.base, policy: { sealed: true as const } } };

    const plan = await planGeminiTurn(services, turn({ model: "gemini-3.1-pro-low" }), sealed, []);
    if (!plan.ok) {
        throw new Error(`planning refused the sealed request: ${plan.message}`);
    }

    expect(plan.request.tools).toEqual(context.base.tools);
    expect(plan.request.policy).toEqual({ sealed: true });
    expect(plan.request.spec.model).toBe("gemini-3.1-pro-low");
    expect(lease).not.toHaveBeenCalled();
});
