import { type Area, type ModelOffer, modelPinKey, type Persona } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import { beforeEach, expect, test, vi } from "vitest";
import type { Services } from "../../composition.js";

/* THE ROUTER, at the seam it spends: askRoleModel is mocked so a test can hand back a reply and see what the router
   makes of it, and the offer is mocked so a test can state what is connected. One reading answers both halves, so what
   a test mostly pins is WHICH halves a given ask puts to a model, and what it never asks at all. */

const ask = vi.fn<(prompt: string) => Promise<string>>();
// Which role each ask named, so a test can pin that both halves spend one list, and it is the routing one.
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

const { candidateLine, routeAnswer, routeChat, routerPrompt } = await import("./chat-router.js");

const NOW = 1_700_000_000_000;

const OFFER: ModelOffer = {
    models: [
        { provider: "claude", model: "claude-opus-5", label: "Opus 5", efforts: ["low", "high"] },
        { provider: "claude", model: "claude-haiku-4-5", label: "Haiku 4.5", efforts: ["low"] },
    ],
    accounts: { claude: [{ id: "work", label: "work", windows: [{ short: "5h", left: 62 }] }] },
};

const CARDS: readonly Persona[] = [
    { id: "backend", label: "Backend", capabilities: ["github"], brief: "Backend work on the api and billing services.", context: { repos: ["api", "billing"] } },
    { id: "social", label: "Social", capabilities: ["reddit-work", "x-work"], brief: "Posting and replying as the studio." },
    { id: "docs", capabilities: [], workspace: { startIn: "docs" } },
];

const warn = vi.fn();
// Named parts of the workspace, read only when the asker is fenced: the router picks from the personas their areas reach.
const AREAS: readonly Area[] = [
    { id: "docs", folders: ["docs"] },
    { id: "finance", folders: ["finance"] },
];

// The owner's standing preferences live in settings, so a router test states them the way the daemon reads them.
const services = (over: { guidance?: string; cards?: readonly Persona[] } = {}): Services =>
    unstubbed<Services>("services", {
        personas: unstubbed<Services["personas"]>("personas", { list: async () => [...(over.cards ?? CARDS)] }),
        areas: unstubbed<Services["areas"]>("areas", { list: async () => [...AREAS] }),
        capabilities: unstubbed<Services["capabilities"]>("capabilities", {
            list: async () =>
                [
                    { id: "reddit-work", kind: "browser", config: { platform: "reddit" } },
                    { id: "x-work", kind: "browser", config: { platform: "x" } },
                    { id: "github", kind: "cli", config: { provider: "github" } },
                ] as Awaited<ReturnType<Services["capabilities"]["list"]>>,
        }),
        logger: unstubbed<Services["logger"]>("logger", { warn } as Partial<Services["logger"]>),
        sandboxSettings: unstubbed<Services["sandboxSettings"]>("sandboxSettings", {
            get: async () => ({ autoModelGuidance: over.guidance ?? "" }) as Awaited<ReturnType<Services["sandboxSettings"]["get"]>>,
        }),
    });

// The three shapes an ask comes in, named the way the two settings produce them.
const BOTH = { prompt: "the invoice totals are off in billing", paths: [] as string[], model: true, persona: true };
const MODEL_ONLY = { ...BOTH, persona: false };
const PERSONA_ONLY = { ...BOTH, model: false };

beforeEach(() => {
    ask.mockReset();
    warn.mockReset();
    roles.splice(0);
    offer.mockReset();
    offer.mockReturnValue(OFFER);
});

test("a persona is one line: its own sentence, then what it carries, where it starts, and the sites it speaks through", () => {
    const site = (id: string): string | undefined => ({ "reddit-work": "reddit", "x-work": "x" })[id];
    expect(candidateLine(CARDS[0]!, site)).toBe("- backend (Backend): Backend work on the api and billing services. Carries: api, billing. Speaks through: github.");
    expect(candidateLine(CARDS[1]!, site)).toBe("- social (Social): Posting and replying as the studio. Speaks through: reddit, x.");
    // No brief, no context, no accounts: the line is the id and the one fact the persona has.
    expect(candidateLine(CARDS[2]!, site)).toBe("- docs: Starts in: docs.");
    expect(candidateLine({ id: "bare", capabilities: [] }, site)).toBe("- bare");
});

test("asked both questions, one prompt carries both lists and asks for four lines", () => {
    const prompt = routerPrompt({ ...BOTH, paths: ["billing/src/totals.ts"] }, { offer: OFFER, personas: CARDS }, NOW);
    expect(prompt).toMatch(/^Choose what a new chat opens on/u);
    expect(prompt).toContain("- backend (Backend): Backend work on the api and billing services.");
    expect(prompt).toContain("- claude:claude-opus-5 — Opus 5. Effort: low, high.");
    expect(prompt).toContain("  - work — 5h: 62% left");
    expect(prompt).toContain("the invoice totals are off in billing");
    expect(prompt).toContain("- The message names 1 file: `billing/src/totals.ts`.");
    expect(prompt).toContain("Reply with exactly these 4 lines and nothing else:\npersona: <one persona id from the list above, or `none`>\nmodel:");
});

test("asked only about the model, the prompt says nothing about personas", () => {
    const prompt = routerPrompt(MODEL_ONLY, { offer: OFFER }, NOW);
    expect(prompt).toMatch(/^Choose the model a new chat should run on/u);
    expect(prompt).not.toContain("persona");
    expect(prompt).toContain("Reply with exactly these 3 lines and nothing else:\nmodel:");
});

test("asked only about the persona, the prompt says nothing about models or allowances", () => {
    const prompt = routerPrompt(PERSONA_ONLY, { personas: CARDS }, NOW);
    expect(prompt).toMatch(/^Choose which persona should handle a new chat/u);
    expect(prompt).toContain("`none` is the right answer when the message is general");
    expect(prompt).not.toContain("Models you may choose:");
    expect(prompt).not.toContain("allowance");
    expect(prompt.trimEnd().endsWith("Reply with exactly this line and nothing else:\npersona: <one persona id from the list above, or `none`>")).toBe(true);
});

test("each fact is shown only to the half that can use it, and only when the chat has it", () => {
    const facts = { ...BOTH, folder: "billing", editorContext: true, planMode: true };
    const both = routerPrompt(facts, { offer: OFFER, personas: CARDS }, NOW);
    expect(both).toContain("- Opened in the folder `billing`.");
    expect(both).toContain("plan mode");
    // The folder is ground a persona works on; with no persona to choose it is noise in a prompt about models.
    expect(routerPrompt(facts, { offer: OFFER }, NOW)).not.toContain("Opened in the folder");
    // Plan mode and a pointed-at selection say how hard the work is, which is not a question about personas.
    expect(routerPrompt(facts, { personas: CARDS }, NOW)).not.toContain("plan mode");
    expect(routerPrompt(BOTH, { offer: OFFER, personas: CARDS }, NOW)).not.toContain("Facts about the chat:");
});

test("a long message is front-loaded: the tail only dilutes the question it opens with", () => {
    const prompt = routerPrompt({ ...BOTH, prompt: "x".repeat(900) }, { offer: OFFER }, NOW);
    expect(prompt).toContain("… (truncated)");
    expect(prompt).not.toContain("x".repeat(700));
});

test("the owner's own preferences are folded in, ahead of the lists and the format they must be answered in", () => {
    const prompt = routerPrompt(BOTH, { offer: OFFER, personas: CARDS }, NOW, "  Keep the work account for real work.  ");
    expect(prompt).toContain("Where they disagree with the paragraphs above, follow the owner:\nKeep the work account for real work.");
    // Ahead of both, so the last thing read is the contract the reply is parsed against, whatever the owner wrote.
    expect(prompt.indexOf("Keep the work account")).toBeLessThan(prompt.indexOf("Models you may choose:"));
    expect(prompt.indexOf("Keep the work account")).toBeLessThan(prompt.indexOf("Reply with exactly"));
});

test("an owner who wrote nothing is not quoted as having written nothing", () => {
    const written = routerPrompt(BOTH, { offer: OFFER }, NOW, "   ");
    expect(written).toBe(routerPrompt(BOTH, { offer: OFFER }, NOW));
    expect(written).not.toContain("follow the owner");
});

test("one reply answers both halves, each read against its own list", () => {
    const answer = routeAnswer({ offer: OFFER, personas: CARDS });
    expect(answer.read("persona: backend\nmodel: claude:claude-opus-5\neffort: high\naccount: work")).toEqual({
        persona: { id: "backend", token: "backend" },
        model: { pick: { provider: "claude", model: "claude-opus-5", effort: "high", account: "work" }, token: "claude:claude-opus-5" },
    });
    expect(answer.unusable(answer.read("persona: none\nmodel: claude:claude-opus-5"))).toBeUndefined();
    // A keyed reply that answered the model and skipped the persona line means no persona, the safe answer, rather
    // than a rung that ignored its instructions and cost the model pick with it.
    expect(answer.read("model: claude:claude-opus-5").persona).toEqual({ id: undefined, token: "none" });
    expect(answer.unusable(answer.read("model: claude:claude-opus-5"))).toBeUndefined();
});

test("an answer off either list is a rung that ignored it, not a softer answer", () => {
    const answer = routeAnswer({ offer: OFFER, personas: CARDS });
    expect(answer.unusable(answer.read("persona: frontend\nmodel: claude:claude-opus-5"))).toBe(`named "frontend", which is no persona here`);
    expect(answer.unusable(answer.read("persona: backend\nmodel: openai:gpt-9"))).toBe(`named "openai:gpt-9", which is not on the list it was given`);
    // Prose answers both questions badly at once, and both halves say so rather than one of them quietly passing.
    expect(answer.unusable(answer.read("Opus, obviously"))).toBe(`named "Opus,", which is no persona here; named no model at all`);
});

test("asked only about the persona, a bare id is a whole answer", () => {
    const answer = routeAnswer({ personas: CARDS });
    expect(answer.read("backend")).toEqual({ persona: { id: "backend", token: "backend" } });
    expect(answer.read("`Social`.")).toEqual({ persona: { id: "social", token: "Social" } });
    expect(answer.read("Persona: backend\nbecause it mentions billing")).toEqual({ persona: { id: "backend", token: "backend" } });
    expect(answer.unusable(answer.read("None."))).toBeUndefined();
    expect(answer.unusable(answer.read("I think the backend persona fits"))).toBe(`named "I", which is no persona here`);
    // Nothing about the model is read when nothing about it was asked.
    expect(answer.read("backend").model).toBeUndefined();
});

test("both settings on: one reading, one role, and both verdicts come back with the model that gave them", async () => {
    ask.mockResolvedValue("persona: backend\nmodel: claude:claude-opus-5\neffort: high\naccount: work");
    const route = await routeChat(services(), { ...BOTH, paths: ["billing/src/totals.ts"] }, undefined);
    expect(roles).toEqual(["model-router"]);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(route).toEqual({
        persona: { id: "backend", reason: "The message reads like Backend's work." },
        model: {
            pick: { provider: "claude", model: "claude-opus-5", effort: "high", account: "work" },
            reason: "Read the opening message as work for Opus 5 at high effort on work.",
        },
        judge: RUNG_KEY,
    });
});

test("auto model on, persona matching off: the model is chosen and nothing is read about personas", async () => {
    ask.mockResolvedValue("model: claude:claude-opus-5");
    const route = await routeChat(services(), MODEL_ONLY, undefined);
    expect(route.persona).toBeUndefined();
    expect(route.model?.pick).toEqual({ provider: "claude", model: "claude-opus-5" });
    expect(ask.mock.calls[0]?.[0]).not.toContain("persona");
});

test("persona matching on, auto model off: no allowance is read, and nothing is said about the model", async () => {
    ask.mockResolvedValue("backend");
    const route = await routeChat(services(), PERSONA_ONLY, undefined);
    expect(route).toEqual({ persona: { id: "backend", reason: "The message reads like Backend's work." }, judge: RUNG_KEY });
    // An offer costs live allowance readings; a chat that only wants a persona is not charged for them.
    expect(offer).not.toHaveBeenCalled();
});

test("the reading a chat spends carries the guidance the owner saved in settings", async () => {
    ask.mockResolvedValue("model: claude:claude-opus-5");
    await routeChat(services({ guidance: "Cheap work goes to Haiku." }), MODEL_ONLY, undefined);
    expect(ask.mock.calls[0]?.[0]).toContain("Cheap work goes to Haiku.");
});

test("nothing connected is answered plainly, with no model asked at all", async () => {
    offer.mockReturnValue({ models: [], accounts: {} });
    const route = await routeChat(services(), MODEL_ONLY, undefined);
    expect(route).toEqual({ model: { reason: "Nothing connected can run a turn right now, so this chat keeps the model it had." } });
    expect(roles).toEqual([]);
});

test("one runnable model is not a choice, and no reading is spent confirming it", async () => {
    offer.mockReturnValue({ models: [OFFER.models[1]!], accounts: OFFER.accounts });
    const route = await routeChat(services(), MODEL_ONLY, undefined);
    expect(route).toEqual({ model: { pick: { provider: "claude", model: "claude-haiku-4-5" }, reason: "Haiku 4.5 is the only model with allowance left." } });
    expect(roles).toEqual([]);
});

test("a half that answers itself is not put to the model, and the other half still is", async () => {
    // One runnable model, so only the persona is worth asking about; the prompt is the persona-only one.
    offer.mockReturnValue({ models: [OFFER.models[1]!], accounts: OFFER.accounts });
    ask.mockResolvedValue("backend");
    const route = await routeChat(services(), BOTH, undefined);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask.mock.calls[0]?.[0]).not.toContain("Models you may choose:");
    expect(route.model?.pick).toEqual({ provider: "claude", model: "claude-haiku-4-5" });
    expect(route.persona?.id).toBe("backend");
});

test("a chat opened in a folder exactly one persona works in is that persona's, and only the model is asked", async () => {
    ask.mockResolvedValue("model: claude:claude-opus-5");
    const route = await routeChat(services(), { ...BOTH, folder: "docs" }, undefined);
    expect(route.persona).toEqual({ id: "docs", reason: "Opened in docs, which docs works in." });
    expect(ask.mock.calls[0]?.[0]).not.toContain("Personas:");
    // With nothing else to ask, a folder match spends no reading at all.
    expect(await routeChat(services(), { ...PERSONA_ONLY, folder: "api" }, undefined)).toEqual({ persona: { id: "backend", reason: "Opened in api, which Backend works in." } });
    expect(ask).toHaveBeenCalledTimes(1);
});

test("a folder nobody works in falls through to the words", async () => {
    ask.mockResolvedValue("social");
    const route = await routeChat(services(), { ...PERSONA_ONLY, folder: "marketing" }, undefined);
    expect(route.persona).toEqual({ id: "social", reason: "The message reads like Social's work." });
    expect(ask.mock.calls[0]?.[0]).toContain("- Opened in the folder `marketing`.");
});

test("none is a real answer, said with the rung that gave it", async () => {
    ask.mockResolvedValue("none");
    expect(await routeChat(services(), { ...PERSONA_ONLY, prompt: "what is a closure?" }, undefined)).toEqual({
        persona: { reason: "No persona fits this message." },
        judge: RUNG_KEY,
    });
});

test("no personas means nothing to route onto, and no call", async () => {
    expect(await routeChat(services({ cards: [] }), PERSONA_ONLY, undefined)).toEqual({ persona: { reason: "No personas to route onto." } });
    expect(ask).not.toHaveBeenCalled();
});

// Routing a fenced asker onto a persona they cannot wear would open the chat on one that refuses every message, so the
// candidates are cut to their own areas first — and a fence holding none ends the persona half before any model is asked.
test("a fenced asker is routed only within their own areas, and none there means no call", async () => {
    expect(await routeChat(services(), { ...PERSONA_ONLY, folder: "docs" }, ["docs"])).toEqual({ persona: { id: "docs", reason: "Opened in docs, which docs works in." } });
    expect(await routeChat(services(), PERSONA_ONLY, ["finance"])).toEqual({ persona: { reason: "No personas to route onto." } });
    expect(ask).not.toHaveBeenCalled();
});

test("a spent chain takes nothing with it: every half says why, and what settled itself still stands", async () => {
    ask.mockRejectedValue(new Error("every account is out of allowance"));
    const route = await routeChat(services(), { ...BOTH, folder: "docs" }, undefined);
    expect(route).toEqual({
        // Matched on the folder before any model was asked, so the failure below cannot take it away.
        persona: { id: "docs", reason: "Opened in docs, which docs works in." },
        model: { reason: "Couldn't choose a model: every account is out of allowance" },
    });
    expect(warn).toHaveBeenCalledWith({ err: expect.any(Error) }, "chat router: no answer, the chat keeps what it had");
});

test("a chat with nothing left to ask spends nothing at all", async () => {
    expect(await routeChat(services(), { ...BOTH, model: false, persona: false }, undefined)).toEqual({});
    expect(ask).not.toHaveBeenCalled();
    expect(offer).not.toHaveBeenCalled();
});
