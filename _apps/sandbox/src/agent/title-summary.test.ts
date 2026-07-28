import { expect, test } from "vitest";
import { cleanSessionTitle } from "./title-summary.js";

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
