import { expect, test } from "vitest";
import { assignVerdict, fenceVerdict, isMemberAddress } from "./ownership.js";

// The three ways a conversation changes hands, and the one way it does not: a collaborator reaching for someone else's.

const owned = { email: "ania@example.com", name: "Ania", since: 1 };

test("nobody's conversation is anyone's to claim, at any driving tier", () => {
    expect(assignVerdict(undefined, { email: "bob@example.com", role: "collaborator" })).toEqual({ kind: "ok" });
});

test("its owner hands it over, whatever their tier; addresses compare folded", () => {
    expect(assignVerdict(owned, { email: "Ania@Example.com", role: "collaborator" })).toEqual({ kind: "ok" });
});

test("a maintainer or the sandbox owner reassigns anyone's", () => {
    expect(assignVerdict(owned, { email: "bob@example.com", role: "maintainer" })).toEqual({ kind: "ok" });
    expect(assignVerdict(owned, { email: "bob@example.com", role: "owner" })).toEqual({ kind: "ok" });
});

test("a collaborator is refused someone else's, with the owner named so the next step is a person", () => {
    const verdict = assignVerdict(owned, { email: "bob@example.com", role: "collaborator" });
    expect(verdict.kind).toBe("forbidden");
    expect(verdict.kind === "forbidden" ? verdict.message : "").toContain("Ania's");
});

test("an owner must sign in here: the sandbox owner or a listed member, folded", () => {
    const members = [{ email: "bob@example.com" }];
    expect(isMemberAddress("Bob@example.com", "root@example.com", members)).toBe(true);
    expect(isMemberAddress("ROOT@example.com", "root@example.com", members)).toBe(true);
    expect(isMemberAddress("stranger@example.com", "root@example.com", members)).toBe(false);
    expect(isMemberAddress("root@example.com", undefined, [])).toBe(false);
});

// Assignment is the one route that can hand a conversation to somebody who could not have started it, so without
// this it is the way around every other narrowing: a fenced member cannot read `finance/`, but an unfenced
// colleague's conversation about it, handed over, is that folder in prose.
test("work stays behind the fence when it changes hands", () => {
    expect(fenceVerdict(["support"], ["support", "finance"], "fay@example.com")).toEqual({ kind: "ok" });
    // Unfenced holders cover everything; the sandbox owner is on no roster row and reaches here as `undefined`.
    expect(fenceVerdict(["support"], undefined, "ada@example.com")).toEqual({ kind: "ok" });
    // Narrowing is always allowed: the conversation keeps its own fence when it moves, so a wider holder changes
    // nothing about what it may touch.
    expect(fenceVerdict(undefined, undefined, "ada@example.com")).toEqual({ kind: "ok" });
});

test("a conversation born wider than the member is refused, and the refusal says what to do", () => {
    const verdict = fenceVerdict(["finance"], ["support"], "fay@example.com");
    expect(verdict.kind).toBe("forbidden");
    expect(verdict.kind === "forbidden" ? verdict.message : "").toContain("widen their access first");
});

// The dangerous direction: an all-access conversation handed to somebody who holds a fence.
test("an unfenced conversation cannot be handed to a fenced member", () => {
    expect(fenceVerdict(undefined, ["support"], "fay@example.com").kind).toBe("forbidden");
});
