import { beforeEach, expect, type Mock, test, vi } from "vitest";
import type { Services } from "../../composition.js";
import { unstubbed } from "@intentic/testing";
import { cleanSessionTitle, nameAgentTitle } from "./title-namer.js";

const ask = vi.fn<() => Promise<{ value: string }>>();
// Whether a model is set for session titles; false means this pass must ask before spending anything.
const modelSet = vi.fn<() => boolean>(() => true);
vi.mock("./role-model.js", () => ({ askRoleModel: () => ask(), roleModelIsSet: async () => modelSet() }));

// Same instinct as cleanCommitSubject: an answer's wrapper is stripped rather than refusing a good name over stray
// formatting.

test("takes the name and nothing but the name", () => {
    expect(cleanSessionTitle("Sandbox freezes · fix")).toBe("Sandbox freezes · fix");
    expect(cleanSessionTitle("```\nSandbox freezes · fix\n```")).toBe("Sandbox freezes · fix");
    expect(cleanSessionTitle(`"Sandbox freezes · fix"`)).toBe("Sandbox freezes · fix");
    expect(cleanSessionTitle("Title: Sandbox freezes · fix")).toBe("Sandbox freezes · fix");
    expect(cleanSessionTitle("Session name: Sandbox freezes · fix")).toBe("Sandbox freezes · fix");
    expect(cleanSessionTitle("- Sandbox freezes · fix")).toBe("Sandbox freezes · fix");
    // The first non-empty line is the name; a trailing explanation has nowhere to go.
    expect(cleanSessionTitle("Sandbox freezes · fix\n\nThis names the work because…")).toBe("Sandbox freezes · fix");
});

test("drops a trailing period but keeps one inside a reference", () => {
    expect(cleanSessionTitle("Sandbox freezes · fix.")).toBe("Sandbox freezes · fix");
    expect(cleanSessionTitle("conversation.ts titles · rewrite")).toBe("conversation.ts titles · rewrite");
});

test("keeps quotes that are part of the name", () => {
    expect(cleanSessionTitle(`"Resume with Claude" prompt · remove`)).toBe(`"Resume with Claude" prompt · remove`);
});

// The separator feeds the browser's action tag (sessionCategory.ts), so it is normalised even when the model already
// got the name right.

test("normalises whatever separator the model reached for", () => {
    expect(cleanSessionTitle("Sandbox freezes - fix")).toBe("Sandbox freezes · fix");
    expect(cleanSessionTitle("Sandbox freezes — fix")).toBe("Sandbox freezes · fix");
    expect(cleanSessionTitle("Sandbox freezes | fix")).toBe("Sandbox freezes · fix");
    expect(cleanSessionTitle("Sandbox freezes•fix")).toBe("Sandbox freezes · fix");
});

test("leaves a hyphenated noun alone", () => {
    // A bare hyphen inside a compound noun must survive; splitting it here would misname the session.
    expect(cleanSessionTitle("Resume-with-Claude prompt · remove")).toBe("Resume-with-Claude prompt · remove");
    expect(cleanSessionTitle("Auth refresh-loop")).toBe("Auth refresh-loop");
});

test("returns empty for a reply with nothing in it", () => {
    expect(cleanSessionTitle("")).toBe("");
    expect(cleanSessionTitle("```\n```")).toBe("");
});

// Fake registry: only entry() and setTitle matter; the mocked role model's reply, or that it was never asked, is what
// each test checks.

// Old titles a broken guard once let through; still checked here so cards already wearing one can heal.
const STOLEN_TITLES = [
    "You've hit your session limit · resets 11:50pm (UTC)",
    "Failed to authenticate. API Error: 401 OAuth access token has been revoked",
    "[tool_call: glob for pattern '**']",
    "Claude Haiku",
    "claude-haiku-4-5",
    "I am Claude",
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
    modelSet.mockReturnValue(true);
});

test("asks nothing when no model is set for session titles", async () => {
    const setTitle = vi.fn<Services["agents"]["setTitle"]>();
    modelSet.mockReturnValue(false);

    await nameAgentTitle(servicesWith({ title: "Fix the auth tests", titleSource: "derived" }, setTitle), "c1", "fix the auth tests");

    expect(ask).not.toHaveBeenCalled();
    expect(setTitle).not.toHaveBeenCalled();
});

test("names a still-derived conversation from the prompt that just opened its turn", async () => {
    const setTitle = vi.fn<Services["agents"]["setTitle"]>();
    ask.mockResolvedValue({ value: "Fleet board broadcast · wire" });
    await nameAgentTitle(
        servicesWith({ title: "We should look at the fleet board and figure out why it…", titleSource: "derived" }, setTitle),
        "c1",
        "we should look at the fleet board and figure out why it stops updating",
    );
    expect(setTitle).toHaveBeenCalledWith("c1", "Fleet board broadcast · wire", "model");
});

test("leaves a conversation that already answers to a better name alone", async () => {
    // titleSource `plan` outranks a model name, skipping the call rather than paying for promoteTitle to reject it.
    const setTitle = vi.fn<Services["agents"]["setTitle"]>();
    await nameAgentTitle(servicesWith({ title: "Session titles · rethink", titleSource: "plan" }, setTitle), "c1", "rethink session titles");
    expect(ask).not.toHaveBeenCalled();
    expect(setTitle).not.toHaveBeenCalled();
});

test("a chain that never wrote a usable name leaves the derived title standing", async () => {
    const setTitle = vi.fn<Services["agents"]["setTitle"]>();
    ask.mockRejectedValue(new Error("gemini-3.5-flash: wrote a tool call instead of a session title"));

    await expect(
        nameAgentTitle(servicesWith({ title: "Fix the auth tests", titleSource: "derived" }, setTitle), "c1", "fix the auth tests"),
    ).rejects.toThrow(/tool call/);

    expect(setTitle).not.toHaveBeenCalled();
});

test.each(STOLEN_TITLES)("a stored title reading %s counts as no name: the pass runs again and heals it", async (stolen) => {
    const setTitle = vi.fn<Services["agents"]["setTitle"]>();
    ask.mockResolvedValue({ value: "Auth test flakiness · fix" });
    await nameAgentTitle(servicesWith({ title: stolen, titleSource: "model" }, setTitle), "c1", "fix the auth tests");
    expect(setTitle).toHaveBeenCalledWith("c1", "Auth test flakiness · fix", "model");
});
