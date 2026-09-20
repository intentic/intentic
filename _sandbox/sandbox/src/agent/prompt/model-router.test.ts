import { type ModelOffer, modelPinKey } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import { beforeEach, expect, test, vi } from "vitest";
import type { Services } from "../../composition.js";

/* THE ROUTER, at the seam it spends: askRoleModel is mocked so a test can hand back a reply and see what the router
   makes of it, and the offer is mocked so a test can state what is connected. */

const ask = vi.fn<(prompt: string) => Promise<string>>();
// Which role each ask named, so a test can pin that the router spends the Auto list and no other.
const roles: string[] = [];
// The rung the mocked walk lands on, and the key the answer reports it back as.
const RUNG = { provider: "claude", model: "haiku" };
const RUNG_KEY = modelPinKey(RUNG);

vi.mock("../models/role-model.js", () => ({
    askRoleModel: async (
        _services: unknown,
        role: string,
        request: { prompt: string; answer: { read: (reply: string) => unknown; unusable: (value: never) => string | undefined } },
    ) => {
        roles.push(role);
        const { readRoleAnswer } = await import("../models/role-answer.js");
        return { value: readRoleAnswer(request.answer as never, await ask(request.prompt)), choice: RUNG, skipped: [] };
    },
}));

const offer = vi.fn<() => ModelOffer>();
vi.mock("../models/auto-offer.js", () => ({ autoOffer: async () => offer() }));

const { routeAnswer, routeModel, routerPrompt } = await import("./model-router.js");

const NOW = 1_700_000_000_000;

const OFFER: ModelOffer = {
    models: [
        { provider: "claude", model: "claude-opus-5", label: "Opus 5", efforts: ["low", "high"] },
        { provider: "claude", model: "claude-haiku-4-5", label: "Haiku 4.5", efforts: ["low"] },
    ],
    accounts: { claude: [{ id: "work", label: "work", windows: [{ short: "5h", left: 62 }] }] },
};

const warn = vi.fn();
// The owner's standing preferences live in settings, so a router test states them the way the daemon reads them.
const services = (autoModelGuidance = ""): Services =>
    unstubbed<Services>("services", {
        logger: unstubbed<Services["logger"]>("logger", { warn } as Partial<Services["logger"]>),
        sandboxSettings: unstubbed<Services["sandboxSettings"]>("sandboxSettings", {
            get: async () => ({ autoModelGuidance }) as Awaited<ReturnType<Services["sandboxSettings"]["get"]>>,
        }),
    });

const ASK = { prompt: "the invoice totals are off in billing", paths: [] as string[] };

beforeEach(() => {
    ask.mockReset();
    warn.mockReset();
    roles.splice(0);
    offer.mockReturnValue(OFFER);
});

test("the prompt carries every offered model, every account's remaining allowance, and the message", () => {
    const prompt = routerPrompt({ ...ASK, paths: ["billing/src/totals.ts"] }, OFFER, NOW);
    expect(prompt).toContain("- claude:claude-opus-5 — Opus 5. Effort: low, high.");
    expect(prompt).toContain("  - work — 5h: 62% left");
    expect(prompt).toContain("the invoice totals are off in billing");
    // Facts the words alone cannot carry; a message naming files is a different job from the same sentence naming none.
    expect(prompt).toContain("- The message names 1 file: `billing/src/totals.ts`.");
});

test("facts the chat does not have are not stated: an ordinary message's prompt stays short", () => {
    const prompt = routerPrompt(ASK, OFFER, NOW);
    expect(prompt).not.toContain("Facts about the chat:");
    expect(prompt).not.toContain("plan mode");
});

test("a long message is front-loaded: the tail only dilutes the question it opens with", () => {
    const prompt = routerPrompt({ ...ASK, prompt: "x".repeat(900) }, OFFER, NOW);
    expect(prompt).toContain("… (truncated)");
    expect(prompt).not.toContain("x".repeat(700));
});

test("the owner's own preferences are folded in, ahead of the list and the format they must be answered in", () => {
    const prompt = routerPrompt(ASK, OFFER, NOW, "  Keep the work account for real work.  ");
    expect(prompt).toContain("Where they disagree with the two paragraphs above, follow the owner:\nKeep the work account for real work.");
    // Ahead of both, so the last thing read is the contract the reply is parsed against, whatever the owner wrote.
    expect(prompt.indexOf("Keep the work account")).toBeLessThan(prompt.indexOf("Models you may choose:"));
    expect(prompt.indexOf("Keep the work account")).toBeLessThan(prompt.indexOf("Reply with exactly these three lines"));
});

test("an owner who wrote nothing is not quoted as having written nothing", () => {
    const written = routerPrompt(ASK, OFFER, NOW, "   ");
    expect(written).toBe(routerPrompt(ASK, OFFER, NOW));
    expect(written).not.toContain("follow the owner");
});

test("the reply is read as three keyed lines against the offer", () => {
    const answer = routeAnswer(OFFER);
    expect(answer.read("model: claude:claude-opus-5\neffort: high\naccount: work")).toEqual({
        pick: { provider: "claude", model: "claude-opus-5", effort: "high", account: "work" },
        token: "claude:claude-opus-5",
    });
    expect(answer.unusable(answer.read("model: claude:claude-opus-5"))).toBeUndefined();
});

test("a model off the list is a rung that ignored it, not a softer answer", () => {
    const answer = routeAnswer(OFFER);
    // Unusable, so the ladder steps to its next rung rather than running an id no provider has.
    expect(answer.unusable(answer.read("model: openai:gpt-9"))).toBe(`named "openai:gpt-9", which is not on the list it was given`);
    expect(answer.unusable(answer.read("Opus, obviously"))).toBe("named no model at all");
});

test("the reading a chat spends carries the guidance the owner saved in settings", async () => {
    ask.mockResolvedValue("model: claude:claude-opus-5");
    await routeModel(services("Cheap work goes to Haiku."), ASK);
    expect(ask.mock.calls[0]?.[0]).toContain("Cheap work goes to Haiku.");
});

test("the Auto list is what gets spent, and the pick comes back with the model that read it", async () => {
    ask.mockResolvedValue("model: claude:claude-opus-5\neffort: high\naccount: work");
    const route = await routeModel(services(), ASK);
    expect(roles).toEqual(["model-router"]);
    expect(route.pick).toEqual({ provider: "claude", model: "claude-opus-5", effort: "high", account: "work" });
    expect(route.judge).toBe(RUNG_KEY);
    // Named whether or not it changed anything: the reading was paid for either way, and the chat says so.
    expect(route.reason).toBe("Read the opening message as work for Opus 5 at high effort on work.");
});

test("nothing connected is answered plainly, with no model asked at all", async () => {
    offer.mockReturnValue({ models: [], accounts: {} });
    const route = await routeModel(services(), ASK);
    expect(route.pick).toBeUndefined();
    expect(route.judge).toBeUndefined();
    expect(roles).toEqual([]);
});

test("one runnable model is not a choice, and no reading is spent confirming it", async () => {
    offer.mockReturnValue({ models: [OFFER.models[1]!], accounts: OFFER.accounts });
    const route = await routeModel(services(), ASK);
    expect(route.pick).toEqual({ provider: "claude", model: "claude-haiku-4-5" });
    expect(roles).toEqual([]);
    expect(route.reason).toBe("Haiku 4.5 is the only model with allowance left.");
});

test("a spent chain takes nothing with it: the chat keeps the model it had, and is told why", async () => {
    ask.mockRejectedValue(new Error("every account is out of allowance"));
    const route = await routeModel(services(), ASK);
    expect(route.pick).toBeUndefined();
    expect(route.reason).toBe("Couldn't choose a model: every account is out of allowance");
    expect(warn).toHaveBeenCalledWith({ err: expect.any(Error) }, "auto model: no answer, the chat keeps the model it had");
});
