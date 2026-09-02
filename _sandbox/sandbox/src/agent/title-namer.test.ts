import { beforeEach, expect, type Mock, test, vi } from "vitest";
import type { Services } from "../composition.js";
import { unstubbed } from "@intentic/testing";
import { cleanSessionTitle, nameAgentTitle } from "./title-namer.js";

const ask = vi.fn<() => Promise<{ value: string }>>();
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

/* The action tag reaches the browser's sessionCategory.ts as the kind of work the card is tinted by, so the
 * separator in front of it is normalised rather than taken as written: a model that answered with the right
 * name and a dash still gets its tag read. */

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
 * the quick model is the mock above: what it answers (or that it was never asked) IS each test's subject. */

/* THE STRINGS THAT ARE NOT NAMES, EVERY ONE THAT HAS ACTUALLY TAKEN A SESSION'S NAME IN THIS FLEET, and the list
 * is the point: the pass guarded the session-limit sentence alone, the auth sentence walked in and took four
 * cards, both were guarded, and a Gemini rung's tool-call stand-in walked in and took four more. Whether a REPLY
 * may become a name is settled at the ask now (quick-answer.ts); what stays this pass's business is whether a
 * STORED one counts as a name at all, which is what lets the cards already wearing these heal. */
const STOLEN_TITLES = [
    \"You've hit your session limit · resets 11:50pm (UTC)\",
    \"Failed to authenticate. API Error: 401 OAuth access token has been revoked\",
    \"[tool_call: glob for pattern '**']\",
    \"Claude Haiku\",
    \"claude-haiku-4-5\",
    \"I am Claude\",
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
    ask.mockResolvedValue({ value: "Fleet board broadcast · wire" });
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

// A chain asked to the bottom without one rung writing a usable name writes NOTHING: the derived title stands
// and the next turn, which has more to go on, asks again. The reply guards that used to live here are the ask's
// now, so what reaches this pass is either a name or a throw.
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
