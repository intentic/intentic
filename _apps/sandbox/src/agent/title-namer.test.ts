import { beforeEach, expect, type Mock, test, vi } from "vitest";
import type { Services } from "../composition.js";
import { unstubbed } from "../testing.js";
import { cleanSessionTitle, nameAgentTitle } from "./title-namer.js";

const ask = vi.fn<() => Promise<{ text: string }>>();
vi.mock("./quick-model.js", () => ({ askQuickModel: () => ask() }));

/* The quick model's name for a session, unwrapped from the packaging models reach for even when told not to.
 * Same instinct as cleanCommitSubject: the name is right and only its wrapper is wrong, and a pass that
 * refuses a good name over a pair of backticks leaves the fleet board wearing the derived guess for nothing. */

test("takes the name and nothing but the name", () => {
    expect(cleanSessionTitle("Sandbox freezes · fix")).toBe("Sandbox freezes · fix");
    expect(cleanSessionTitle("```\nSandbox freezes · fix\n```")).toBe("Sandbox freezes · fix");
    expect(cleanSessionTitle(`"Sandbox freezes · fix"`)).toBe("Sandbox freezes · fix");
    expect(cleanSessionTitle("Title: Sandbox freezes · fix")).toBe("Sandbox freezes · fix");
    expect(cleanSessionTitle("Session name: Sandbox freezes · fix")).toBe("Sandbox freezes · fix");
    expect(cleanSessionTitle("- Sandbox freezes · fix")).toBe("Sandbox freezes · fix");
    // The first non-empty line is the name; an explanation the model added anyway has nowhere to go.
    expect(cleanSessionTitle("Sandbox freezes · fix\n\nThis names the work because…")).toBe("Sandbox freezes · fix");
});

test("drops a trailing period but keeps one inside a reference", () => {
    expect(cleanSessionTitle("Sandbox freezes · fix.")).toBe("Sandbox freezes · fix");
    expect(cleanSessionTitle("conversation.ts titles · rewrite")).toBe("conversation.ts titles · rewrite");
});

test("keeps quotes that are part of the name", () => {
    expect(cleanSessionTitle(`"Resume with Claude" prompt · remove`)).toBe(`"Resume with Claude" prompt · remove`);
});

/* The action tag reaches commitSuggestion.ts as the commit type, so the separator in front of it is normalised
 * rather than taken as written — a model that answered with the right name and a dash still gets its tag read. */

test("normalises whatever separator the model reached for", () => {
    expect(cleanSessionTitle("Sandbox freezes - fix")).toBe("Sandbox freezes · fix");
    expect(cleanSessionTitle("Sandbox freezes — fix")).toBe("Sandbox freezes · fix");
    expect(cleanSessionTitle("Sandbox freezes | fix")).toBe("Sandbox freezes · fix");
    expect(cleanSessionTitle("Sandbox freezes•fix")).toBe("Sandbox freezes · fix");
});

test("leaves a hyphenated noun alone", () => {
    // The one shape a bare hyphen is common to: splitting here would name the session `Resume-with · Claude`.
    expect(cleanSessionTitle("Resume-with-Claude prompt · remove")).toBe("Resume-with-Claude prompt · remove");
    expect(cleanSessionTitle("Auth refresh-loop")).toBe("Auth refresh-loop");
});

test("returns empty for a reply with nothing in it", () => {
    expect(cleanSessionTitle("")).toBe("");
    expect(cleanSessionTitle("```\n```")).toBe("");
});

/* The pass itself, over a fake registry: only the entry read and the title write matter to these rules, and
 * the quick model is the mock above — what it answers (or that it was never asked) IS each test's subject. */

// The conditions the CLI reports as prose (failure-sentences.ts). Every rule below is asserted over BOTH,
// because this pass guarded the first alone and the second walked in and took four sessions' names.
const FAILURE_SENTENCES = [
    "You've hit your session limit · resets 11:50pm (UTC)",
    "Failed to authenticate. API Error: 401 OAuth access token has been revoked",
];

const servicesWith = (
    entry: { title?: string; titleSource?: "derived" | "model" | "plan" | "user" } | undefined,
    setTitle: Mock<Services["agents"]["setTitle"]>,
): Services =>
    unstubbed<Services>("services", {
        agents: unstubbed<Services["agents"]>("agents", { entry: () => entry as ReturnType<Services["agents"]["entry"]>, setTitle }),
    });

beforeEach(() => {
    ask.mockReset();
});

test("names a still-derived conversation from the prompt that just opened its turn", async () => {
    const setTitle = vi.fn<Services["agents"]["setTitle"]>();
    ask.mockResolvedValue({ text: "Fleet board broadcast · wire" });
    await nameAgentTitle(
        servicesWith({ title: "We should look at the fleet board and figure out why it…", titleSource: "derived" }, setTitle),
        "c1",
        "we should look at the fleet board and figure out why it stops updating",
    );
    expect(setTitle).toHaveBeenCalledWith("c1", "Fleet board broadcast · wire", "model");
});

test("leaves a conversation that already answers to a better name alone", async () => {
    // The gate that makes one model call per conversation: a plan heading and a rename both outrank this pass,
    // and spending the call to have promoteTitle reject it is the same title for the price of a turn's latency.
    const setTitle = vi.fn<Services["agents"]["setTitle"]>();
    await nameAgentTitle(servicesWith({ title: "Session titles · rethink", titleSource: "plan" }, setTitle), "c1", "rethink session titles");
    expect(ask).not.toHaveBeenCalled();
    expect(setTitle).not.toHaveBeenCalled();
});

test.each(FAILURE_SENTENCES)("a quick-model reply reading %s never becomes the name", async (failure) => {
    const setTitle = vi.fn<Services["agents"]["setTitle"]>();
    ask.mockResolvedValue({ text: failure });
    await nameAgentTitle(servicesWith({ title: "Fix the auth tests", titleSource: "derived" }, setTitle), "c1", "fix the auth tests");
    expect(setTitle).not.toHaveBeenCalled();
});

test.each(FAILURE_SENTENCES)("a stored title stolen by %s counts as no name — the pass runs again and heals it", async (failure) => {
    const setTitle = vi.fn<Services["agents"]["setTitle"]>();
    ask.mockResolvedValue({ text: "Auth test flakiness · fix" });
    await nameAgentTitle(servicesWith({ title: failure, titleSource: "model" }, setTitle), "c1", "fix the auth tests");
    expect(setTitle).toHaveBeenCalledWith("c1", "Auth test flakiness · fix", "model");
});
