import { unstubbed } from "@intentic/testing";
import type { Services } from "../../composition.js";
import { context, servicesWith, turn } from "../../agent/run/turn/turn-plan.testing.js";
import { testConfig } from "../../testing.js";
import { planGeminiTurn } from "./gemini-provider.js";
import type { GeminiModel } from "./gemini-models.js";
import type { GoogleModelAvailability } from "../../agent/providers/google-model-availability.js";
import { geminiCatalogFake } from "./gemini-provider.testing.js";

// The browser stack reads the machine to find its runtime; planning asks it for servers and nothing more here.
const browserServers = jest.fn();
jest.mock("../../browser/tools/browser-tools.js", () => ({
    ROUTED_BROWSER_SERVER: "browser",
    ANONYMOUS_BROWSER_SERVER: "web",
    browserServersOf: (...args: unknown[]) => browserServers(...args),
    prepareBrowserOwner: jest.fn(),
}));

beforeEach(() => {
    browserServers.mockReset();
    browserServers.mockResolvedValue({ servers: [], accounts: {}, ports: {}, passkeys: {} });
});

// What the Google channel does with the model a turn names. The channel vends one row per model AND per thinking level
// (Claude Opus beside Gemini Pro), each metered on its own allowance, so which id is sent is not a detail: substituting
// spends a different allowance than the one the user chose.

const OFFERED: readonly GeminiModel[] = [
    { id: "claude-opus-4-6-thinking", label: "Claude Opus 4.6 (Thinking)", inputModalities: ["text", "image"] },
    { id: "gemini-3.1-pro-low", label: "Gemini 3.1 Pro (Low)", inputModalities: ["text", "image"] },
];

const geminiServices = (
    models: readonly GeminiModel[] = OFFERED,
    served: { readonly live?: boolean; readonly availability?: GoogleModelAvailability } = {},
): Services =>
    servicesWith({
        config: { ...testConfig, translator: { url: "http://127.0.0.1:8788", token: "local" } },
        cliProxy: unstubbed<Services["cliProxy"]>("cliProxy", {
            accounts: async () => ({ codex: [], grok: [], kimi: [], gemini: [{ name: "google", label: "google" }] }),
        }),
        geminiModels: geminiCatalogFake(models, served),
        async *geminiAgent() {},
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
    // Account membership is authoritative; display metadata's disappearance grace cannot authorize this pin.
    const plan = await planGeminiTurn(geminiServices([OFFERED[1]!]), turn({ model: "claude-opus-4-6-thinking" }), context, []);

    expect(plan).toEqual({
        ok: false,
        code: "model-unavailable",
        message:
            "Google does not currently offer claude-opus-4-6-thinking through this sandbox's enabled account pool. " +
            "Pick an available model explicitly, or send again if it becomes available.",
    });
});

test("refuses a turn the translator has no Google model to serve, instead of sending it to fail as unknown", async () => {
    const plan = await planGeminiTurn(geminiServices(OFFERED, { live: false }), turn({ model: "claude-opus-4-6-thinking" }), context, []);

    expect(plan).toEqual({
        ok: false,
        message:
            "The model translator's Google catalog could not be verified. " + "Send again in a minute; your selected model has not been changed.",
    });
});

test("refuses a globally advertised Opus 5.5 that the enabled account pool does not offer, before mounting tools", async () => {
    const advertised = [...OFFERED, { id: "claude-opus-5-5-high", label: "Opus 5.5", inputModalities: ["text" as const, "image" as const] }];
    const plan = await planGeminiTurn(
        geminiServices(advertised, { availability: { state: "verified", accounts: 31, models: OFFERED.map((model) => model.id) } }),
        turn({ model: "claude-opus-5-5-high" }),
        context,
        [],
    );
    expect(plan).toEqual({
        ok: false,
        code: "model-unavailable",
        message:
            "Google does not currently offer claude-opus-5-5-high through this sandbox's enabled account pool. Pick an available model explicitly, or send again if it becomes available.",
    });
    expect(browserServers).not.toHaveBeenCalled();
});

test.each<GoogleModelAvailability>([
    { state: "unknown" },
    { state: "incomplete", accounts: 2, verified: 1, models: OFFERED.map((model) => model.id) },
])("an unverified account pool asks for a retry without changing the pin: %j", async (availability) => {
    const plan = await planGeminiTurn(geminiServices(OFFERED, { availability }), turn({ model: "claude-opus-4-6-thinking" }), context, []);
    expect(plan).toEqual({
        ok: false,
        message:
            "Google model availability could not be verified for every enabled account. Send again in a minute; your selected model has not been changed.",
    });
    expect(browserServers).not.toHaveBeenCalled();
});

test("a verified empty callable catalog refuses an unpinned turn rather than choosing a seed", async () => {
    const plan = await planGeminiTurn(geminiServices(OFFERED, { availability: { state: "verified", accounts: 1, models: [] } }), turn(), context, []);
    expect(plan).toEqual({
        ok: false,
        message:
            "Google's enabled accounts and the model translator currently have no verified chat model in common. Send again in a minute, or choose a different provider explicitly.",
    });
    expect(browserServers).not.toHaveBeenCalled();
});

test("an already-cancelled Google turn never begins model selection or mounts tools", async () => {
    const controller = new AbortController();
    const connected = geminiServices();
    const select = jest.spyOn(connected.geminiModels, "select");
    controller.abort(new Error("turn already cancelled"));
    await expect(planGeminiTurn(connected, turn(), { ...context, base: { ...context.base, signal: controller.signal } }, [])).rejects.toThrow(
        "turn already cancelled",
    );
    expect(select).not.toHaveBeenCalled();
    expect(browserServers).not.toHaveBeenCalled();
});

test("cancellation ends a pending Google selection without waiting for it or mounting tools", async () => {
    const controller = new AbortController();
    const started = Promise.withResolvers<void>();
    const selection = Promise.withResolvers<Awaited<ReturnType<Services["geminiModels"]["select"]>>>();
    const connected = geminiServices();
    const planned = planGeminiTurn(
        {
            ...connected,
            geminiModels: {
                ...connected.geminiModels,
                select: async () => {
                    started.resolve();
                    return selection.promise;
                },
            },
        },
        turn(),
        { ...context, base: { ...context.base, signal: controller.signal } },
        [],
    );
    const failed = planned.catch((error: unknown) => (error instanceof Error ? error.message : String(error)));
    await started.promise;
    controller.abort(new Error("turn cancelled during verification"));
    expect(await failed).toBe("turn cancelled during verification");
    selection.resolve({ ok: true, model: "claude-opus-4-6-thinking" });
    await selection.promise;
    expect(browserServers).not.toHaveBeenCalled();
});

// Gemini rides OpenCode, which now takes the turn's remote MCP servers as Codex does: the browser the persona may drive
// is one of them.
test("hands the turn its remote MCP servers, the browser among them", async () => {
    const web = { name: "web", url: "http://127.0.0.1:1/mcp/web", token: "turn-bearer", timeoutMs: 120_000 };
    browserServers.mockResolvedValue({ servers: [web], accounts: {}, ports: { web: 41_000 }, passkeys: {} });

    const plan = await planGeminiTurn(geminiServices(), turn({ model: "gemini-3.1-pro-low", conversationId: "chat-1" }), context, []);
    if (!plan.ok) {
        throw new Error(`planning refused the turn: ${plan.message}`);
    }

    expect(plan.request.tools.remote).toEqual([web]);
});
