import { expect, test } from "vitest";
import { assignVerdict, isMemberAddress } from "./ownership.js";

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
