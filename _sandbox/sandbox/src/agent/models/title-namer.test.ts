import type { Mock } from "bun:test";
import type { Services } from "../../composition.js";
import { unstubbed } from "@intentic/testing";
import type { Social } from "../../conversations/registry/agents-store.js";
import { conversationAfter } from "../../testing.js";
import { cleanSessionTitle, nameAgentTitle, splitTitleAction } from "./title-namer.js";
import { privacySliceFake } from "../../privacy/privacy-slice.testing.js";

const ask = jest.fn<() => Promise<{ value: string }>>();
// Whether a model is set for session titles; false means this pass must ask before spending anything.
const modelSet = jest.fn<() => boolean>(() => true);
jest.mock("./role-model.js", () => ({ askRoleModel: () => ask(), roleModelIsSet: async () => modelSet() }));

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

// The separator is what splitTitleAction cuts on, so it is normalised even when the model already got the name right.

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

// What the session is actually called: the action word is stored beside the title, never displayed in it.

test("splits the action word off the displayed name", () => {
    expect(splitTitleAction("Sandbox freezes · fix")).toEqual({ title: "Sandbox freezes", action: "fix" });
    expect(splitTitleAction("Deployments Komodo · Audit")).toEqual({ title: "Deployments Komodo", action: "audit" });
    // Nothing to split: a name the model wrote without a tag stands whole, and so does a tag with no subject.
    expect(splitTitleAction("Auth refresh-loop")).toEqual({ title: "Auth refresh-loop" });
    expect(splitTitleAction("· fix")).toEqual({ title: "· fix" });
    // Only the last segment is the action; a name with its own separators keeps everything before it.
    expect(splitTitleAction("Auth · session · refresh")).toEqual({ title: "Auth · session", action: "refresh" });
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

// `turns` is how many turns the conversation finished before the one this pass runs at; 0 is its opening turn.
const servicesWith = (title: Social["title"], setTitle: Mock<Services["agents"]["setTitle"]>, turns = 0): Services =>
    unstubbed<Services>("services", {
        privacyShield: privacySliceFake().privacyShield,
        agents: unstubbed<Services["agents"]>("agents", { entry: () => conversationAfter(turns, { social: { title, reactions: [] } }), setTitle }),
    });

beforeEach(() => {
    ask.mockReset();
    modelSet.mockReturnValue(true);
});

test("asks nothing when no model is set for session titles", async () => {
    const setTitle = jest.fn<Services["agents"]["setTitle"]>();
    modelSet.mockReturnValue(false);

    await nameAgentTitle(servicesWith({ text: "Fix the auth tests", source: "derived" }, setTitle), "c1", "fix the auth tests");

    expect(ask).not.toHaveBeenCalled();
    expect(setTitle).not.toHaveBeenCalled();
});

test("names a still-derived conversation from the prompt that just opened its turn", async () => {
    const setTitle = jest.fn<Services["agents"]["setTitle"]>();
    ask.mockResolvedValue({ value: "Fleet board broadcast · wire" });
    await nameAgentTitle(
        servicesWith({ text: "We should look at the fleet board and figure out why it…", source: "derived" }, setTitle),
        "c1",
        "we should look at the fleet board and figure out why it stops updating",
    );
    expect(setTitle).toHaveBeenCalledWith("c1", "Fleet board broadcast", "model", "wire");
});

test("leaves a conversation that already answers to a better name alone", async () => {
    // titleSource `plan` outranks a model name, skipping the call rather than paying for promoteTitle to reject it.
    const setTitle = jest.fn<Services["agents"]["setTitle"]>();
    await nameAgentTitle(servicesWith({ text: "Session titles · rethink", source: "plan" }, setTitle), "c1", "rethink session titles");
    expect(ask).not.toHaveBeenCalled();
    expect(setTitle).not.toHaveBeenCalled();
});

// A parent's description of its child opens as a `model` name (children.ts). Renaming it is how six children of one
// parent all came to read "testaudit picks"; the card still gets the work word it is tinted by.
test("keeps the words of a name an agent chose as the conversation opened, and gives it only its action", async () => {
    const setTitle = jest.fn<Services["agents"]["setTitle"]>();
    ask.mockResolvedValue({ value: "testaudit picks · audit" });
    await nameAgentTitle(servicesWith({ text: "Test audit reviewer, batch 24", source: "model" }, setTitle), "sub-1", "Review the test audit, batch 24");
    expect(setTitle).toHaveBeenCalledWith("sub-1", "Test audit reviewer, batch 24", "model", "audit");
});

test("asks nothing about a model name past the opening turn, nor about one that already has its action", async () => {
    const setTitle = jest.fn<Services["agents"]["setTitle"]>();
    await nameAgentTitle(servicesWith({ text: "Test audit reviewer, batch 24", source: "model" }, setTitle, 1), "sub-1", "and the next batch");
    await nameAgentTitle(servicesWith({ text: "Test audit reviewer", source: "model", action: "audit" }, setTitle), "sub-1", "review it");
    expect(ask).not.toHaveBeenCalled();
    expect(setTitle).not.toHaveBeenCalled();
});

test("a chain that never wrote a usable name leaves the derived title standing", async () => {
    const setTitle = jest.fn<Services["agents"]["setTitle"]>();
    ask.mockRejectedValue(new Error("gemini-3.5-flash: wrote a tool call instead of a session title"));

    await expect(
        nameAgentTitle(servicesWith({ text: "Fix the auth tests", source: "derived" }, setTitle), "c1", "fix the auth tests"),
    ).rejects.toThrow(/tool call/);

    expect(setTitle).not.toHaveBeenCalled();
});

test.each(STOLEN_TITLES)("a stored title reading %s counts as no name: the pass runs again and heals it", async (stolen) => {
    const setTitle = jest.fn<Services["agents"]["setTitle"]>();
    ask.mockResolvedValue({ value: "Auth test flakiness · fix" });
    await nameAgentTitle(servicesWith({ text: stolen, source: "model" }, setTitle), "c1", "fix the auth tests");
    expect(setTitle).toHaveBeenCalledWith("c1", "Auth test flakiness", "model", "fix");
});
