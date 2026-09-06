import type { Persona } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import { beforeEach, expect, test, vi } from "vitest";
import type { Services } from "../../composition.js";

/* THE ROUTER, at the seam it spends: askRoleModel is mocked so a test can hand back a reply and see what the
 * router makes of it. The walk itself (which rung, what a refusal does) has its own suite (role-model.test.ts);
 * what is testable here is the prompt the rung is shown, the shortcut that skips it, and how its words are read. */

const ask = vi.fn<(prompt: string) => Promise<string>>();
// Which role each ask named, so a test can pin that the router spends the persona-routing list and no other.
const roles: string[] = [];
vi.mock("../models/role-model.js", () => ({
    askRoleModel: async (_services: unknown, role: string, request: { prompt: string; answer: { read: (reply: string) => unknown; unusable: (value: never) => string | undefined } }) => {
        roles.push(role);
        const { readRoleAnswer } = await import("../models/role-answer.js");
        return { value: readRoleAnswer(request.answer as never, await ask(request.prompt)), choice: { provider: "claude", model: "haiku" }, skipped: [] };
    },
}));

const { candidateLine, routeAnswer, routePersona, routerPrompt } = await import("./persona-router.js");

const CARDS: readonly Persona[] = [
    { id: "backend", label: "Backend", capabilities: ["github"], brief: "Backend work on the api and billing services.", context: { repos: ["api", "billing"] } },
    { id: "social", label: "Social", capabilities: ["reddit-work", "x-work"], brief: "Posting and replying as the studio." },
    { id: "docs", capabilities: [], workspace: { startIn: "docs" } },
];

const warn = vi.fn();
const services = (cards: readonly Persona[] = CARDS): Services =>
    unstubbed<Services>("services", {
        personas: unstubbed<Services["personas"]>("personas", { list: async () => [...cards] }),
        capabilities: unstubbed<Services["capabilities"]>("capabilities", {
            list: async () =>
                [
                    { id: "reddit-work", kind: "browser", config: { platform: "reddit" } },
                    { id: "x-work", kind: "browser", config: { platform: "x" } },
                    { id: "github", kind: "cli", config: { provider: "github" } },
                ] as Awaited<ReturnType<Services["capabilities"]["list"]>>,
        }),
        logger: unstubbed<Services["logger"]>("logger", { warn } as Partial<Services["logger"]>),
    });

beforeEach(() => {
    ask.mockReset();
    warn.mockReset();
    roles.splice(0);
});

test("a card is one line: its own sentence, then what it carries, where it starts, and the sites it speaks through", () => {
    const site = (id: string): string | undefined => ({ "reddit-work": "reddit", "x-work": "x" })[id];
    expect(candidateLine(CARDS[0]!, site)).toBe("- backend (Backend): Backend work on the api and billing services. Carries: api, billing. Speaks through: github.");
    expect(candidateLine(CARDS[1]!, site)).toBe("- social (Social): Posting and replying as the studio. Speaks through: reddit, x.");
    // No brief, no context, no accounts: the line is the id and the one fact the card has.
    expect(candidateLine(CARDS[2]!, site)).toBe("- docs: Starts in: docs.");
    expect(candidateLine({ id: "bare", capabilities: [] }, site)).toBe("- bare");
});

test("the reply is an id from the list, case-insensitively and unwrapped, or none; anything else is unusable", () => {
    const answer = routeAnswer(new Set(["backend", "social"]));
    expect(answer.read("backend")).toEqual({ persona: "backend", token: "backend" });
    expect(answer.read("`Social`.")).toEqual({ persona: "social", token: "Social" });
    expect(answer.read("Persona: backend\nbecause it mentions billing")).toEqual({ persona: "backend", token: "backend" });
    expect(answer.read("none")).toEqual({ persona: undefined, token: "none" });
    expect(answer.unusable(answer.read("None."))).toBeUndefined();
    expect(answer.unusable(answer.read("backend"))).toBeUndefined();
    // A card the workspace does not have is a rung that did not read the list, not a softer answer.
    expect(answer.unusable(answer.read("frontend"))).toBe(`named "frontend", which is no persona here`);
    expect(answer.unusable(answer.read("I think the backend persona fits"))).toBe(`named "I", which is no persona here`);
});

test("the rung is shown every card, the chat's facts, and the message; its id comes back with a reason", async () => {
    ask.mockResolvedValue("backend");
    const route = await routePersona(services(), { prompt: "the invoice totals are off in billing", folder: undefined, paths: ["billing/src/totals.ts"] });
    expect(route).toEqual({ persona: "backend", reason: "The message reads like Backend's work." });
    expect(roles).toEqual(["persona-router"]);
    const prompt = ask.mock.calls[0]?.[0] ?? "";
    expect(prompt).toContain("- backend (Backend): Backend work on the api and billing services. Carries: api, billing. Speaks through: github.");
    expect(prompt).toContain("- social (Social):");
    expect(prompt).toContain("- The message names `billing/src/totals.ts`.");
    expect(prompt).toContain("the invoice totals are off in billing");
});

test("none is a real answer, and so is a chain that could not answer at all", async () => {
    ask.mockResolvedValue("none");
    expect(await routePersona(services(), { prompt: "what is a closure?", paths: [] })).toEqual({ reason: "No persona fits this message." });
    ask.mockRejectedValue(new Error("No AI account is connected to this sandbox"));
    expect(await routePersona(services(), { prompt: "fix the login flow", paths: [] })).toEqual({ reason: "Could not route: No AI account is connected to this sandbox" });
    expect(warn).toHaveBeenCalledTimes(1);
});

test("a chat opened in a folder exactly one card works in is that card's, and no model is asked", async () => {
    expect(await routePersona(services(), { prompt: "tidy the readme", folder: "docs", paths: [] })).toEqual({ persona: "docs", reason: "Opened in docs, which docs works in." });
    expect(await routePersona(services(), { prompt: "tidy the readme", folder: "api", paths: [] })).toEqual({ persona: "backend", reason: "Opened in api, which Backend works in." });
    expect(ask).not.toHaveBeenCalled();
    // A folder nobody works in falls through to the words.
    ask.mockResolvedValue("social");
    expect(await routePersona(services(), { prompt: "reply to the thread", folder: "marketing", paths: [] })).toEqual({ persona: "social", reason: "The message reads like Social's work." });
    expect(ask.mock.calls[0]?.[0]).toContain("- Opened in the folder `marketing`.");
});

test("no cards means nothing to route onto, and no call", async () => {
    expect(await routePersona(services([]), { prompt: "anything", paths: [] })).toEqual({ reason: "No personas to route onto." });
    expect(ask).not.toHaveBeenCalled();
});

test("the prompt asks for one id or none and says why none is safe", () => {
    const prompt = routerPrompt({ prompt: "hello", paths: [] }, ["- a", "- b"]);
    expect(prompt).toMatch(/^Which of these personas should handle a new chat\?/u);
    expect(prompt).toContain("`none` is the right answer when the message is general");
    expect(prompt).not.toContain("Facts about the chat");
    expect(prompt.trimEnd().endsWith("Reply with the id or `none` only: no quotes, no explanation.")).toBe(true);
});
