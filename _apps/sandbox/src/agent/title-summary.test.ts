import { beforeEach, expect, test, vi } from "vitest";
import type { Services } from "../composition.js";
import { cleanSessionTitle, summarizeAgentTitle } from "./title-summary.js";

const ask = vi.fn<() => Promise<{ text: string }>>();
vi.mock("./quick-model.js", () => ({ askQuickModel: () => ask() }));

/* The quick model's name for a session, unwrapped from the packaging models reach for even when told not to.
 * Same instinct as cleanCommitSubject: the name is right and only its wrapper is wrong, and a pass that
 * refuses a good name over a pair of backticks leaves the fleet board wearing the derived guess for nothing. */

test("takes the name and nothing but the name", () => {
    expect(cleanSessionTitle("Add workspace health contract")).toBe("Add workspace health contract");
    expect(cleanSessionTitle("```\nAdd workspace health contract\n```")).toBe("Add workspace health contract");
    expect(cleanSessionTitle(`"Add workspace health contract"`)).toBe("Add workspace health contract");
    expect(cleanSessionTitle("Title: Add workspace health contract")).toBe("Add workspace health contract");
    expect(cleanSessionTitle("Session name: Add workspace health contract")).toBe("Add workspace health contract");
    expect(cleanSessionTitle("- Add workspace health contract")).toBe("Add workspace health contract");
    // The first non-empty line is the name; an explanation the model added anyway has nowhere to go.
    expect(cleanSessionTitle("Add workspace health contract\n\nThis names the work because…")).toBe("Add workspace health contract");
});

test("drops a trailing period but keeps one inside a reference", () => {
    expect(cleanSessionTitle("Add workspace health contract.")).toBe("Add workspace health contract");
    expect(cleanSessionTitle("Refactor conversation.ts titles")).toBe("Refactor conversation.ts titles");
});

test("keeps quotes that are part of the name", () => {
    expect(cleanSessionTitle(`Make "have the agent resolve it" the main road`)).toBe(`Make "have the agent resolve it" the main road`);
});

test("returns empty for a reply with nothing in it", () => {
    expect(cleanSessionTitle("")).toBe("");
    expect(cleanSessionTitle("```\n```")).toBe("");
});

/* The pass itself, over a fake registry: only the entry read and the title write matter to these rules, and
 * the quick model is the mock above — what it answers (or that it was never asked) IS each test's subject. */

const LIMIT = "You've hit your session limit · resets 11:50pm (UTC)";

const servicesWith = (
    entry: { title?: string; titleSource?: "derived" | "summary" | "plan" | "user" } | undefined,
    setTitle: ReturnType<typeof vi.fn>,
): Services => ({ agents: { entry: () => entry, setTitle } }) as unknown as Services;

beforeEach(() => {
    ask.mockReset();
});

test("names a still-derived conversation from the finished turn", async () => {
    const setTitle = vi.fn();
    ask.mockResolvedValue({ text: "Wire the fleet board broadcast" });
    await summarizeAgentTitle(servicesWith({ title: "We should look at the fleet…", titleSource: "derived" }, setTitle), "c1", {
        prompt: "we should look at the fleet board",
        closing: "Done — the broadcast now fans out.",
    });
    expect(setTitle).toHaveBeenCalledWith("c1", "Wire the fleet board broadcast", "summary");
});

test("a closing that IS the usage-limit refusal is not an answer to read — no model call, no title", async () => {
    const setTitle = vi.fn();
    await summarizeAgentTitle(servicesWith({ title: "Fix the auth tests", titleSource: "derived" }, setTitle), "c1", {
        prompt: "fix the auth tests",
        closing: LIMIT,
    });
    expect(ask).not.toHaveBeenCalled();
    expect(setTitle).not.toHaveBeenCalled();
});

test("a quick-model reply that is the refusal sentence never becomes the name", async () => {
    const setTitle = vi.fn();
    ask.mockResolvedValue({ text: LIMIT });
    await summarizeAgentTitle(servicesWith({ title: "Fix the auth tests", titleSource: "derived" }, setTitle), "c1", {
        prompt: "fix the auth tests",
        closing: "All green now.",
    });
    expect(setTitle).not.toHaveBeenCalled();
});

test("a stored title stolen by the refusal sentence counts as no name — the pass runs again and heals it", async () => {
    const setTitle = vi.fn();
    ask.mockResolvedValue({ text: "Fix the flaky auth tests" });
    await summarizeAgentTitle(servicesWith({ title: LIMIT, titleSource: "summary" }, setTitle), "c1", {
        prompt: "fix the auth tests",
        closing: "All green now.",
    });
    expect(setTitle).toHaveBeenCalledWith("c1", "Fix the flaky auth tests", "summary");
});
