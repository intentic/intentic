import type { OrgPolicy } from "@intentic/sandbox-contract/schemas/organisation";
import { inheritedSeal } from "./seal-birth.js";
import { freshSeal, inheritedFrom } from "./seal-family.js";
import { houseOf, jailWanted, startsPrivate } from "../../auth/members/seal-house.js";
import type { PersistedAgent } from "../registry/agents-store.js";

// The house rule as it binds, what a new conversation starts as, when every turn is jailed, and what a subagent, a review
// or a fork of a private conversation inherits.

const org = (conversations: NonNullable<OrgPolicy["conversations"]>): OrgPolicy => ({ sections: {}, orgId: "o", orgName: "Org", version: 1, conversations });

describe("houseOf", () => {
    test("everyone reads everything until somebody says otherwise", () => {
        expect(houseOf({ defaults: {} }, undefined)).toEqual({ mode: "everyone", locked: false, twoPerson: false });
    });

    test("an organisation's rule fixes the sandbox's own, and asks for two people where it says so", () => {
        expect(houseOf({ mode: "everyone", defaults: {} }, org({ mode: "private", twoPerson: true }))).toEqual({ mode: "private", locked: true, twoPerson: true });
        expect(houseOf({ mode: "chooses", defaults: {} }, org({ twoPerson: true }))).toEqual({ mode: "chooses", locked: false, twoPerson: true });
    });
});

describe("startsPrivate", () => {
    test("private by default always, the author's own default when they choose, never under everyone", () => {
        const held = { defaults: { "anna@example.com": true } };
        expect(startsPrivate("private", { defaults: {} }, "bob@example.com")).toBe(true);
        expect(startsPrivate("chooses", held, "Anna@Example.com")).toBe(true);
        expect(startsPrivate("chooses", held, "bob@example.com")).toBe(false);
        expect(startsPrivate("everyone", held, "anna@example.com")).toBe(false);
    });
});

describe("jailWanted", () => {
    test("while anything may be private, and while anything still is", () => {
        expect(jailWanted("everyone", 0)).toBe(false);
        expect(jailWanted("everyone", 1)).toBe(true);
        expect(jailWanted("chooses", 0)).toBe(true);
    });
});

describe("inheritedSeal", () => {
    const rootSeal = { ...freshSeal({ email: "anna@example.com" }, [], 1), asks: [{ email: "ola@example.com", at: 2 }] };
    const held = new Map([
        ["root", { id: "root", seal: rootSeal }],
        ["kid", { id: "kid", seal: inheritedFrom("root", rootSeal) }],
    ]);
    const entryOf = (id: string): Pick<PersistedAgent, "id" | "seal"> | undefined => held.get(id);

    test("a subagent takes its parent's seal, without the asks, naming the root", () => {
        expect(inheritedSeal({ startedBy: "agent:root" }, entryOf)).toEqual({ since: 1, readers: [{ email: "anna@example.com" }], from: "root" });
    });

    test("a grandchild and a fork name the same root", () => {
        expect(inheritedSeal({ startedBy: "agent:kid" }, entryOf)?.from).toBe("root");
        expect(inheritedSeal({ forkedFrom: { conversationId: "kid", index: 3, files: "now" } }, entryOf)?.from).toBe("root");
    });

    test("a conversation a person started on nothing private inherits nothing", () => {
        expect(inheritedSeal({ startedBy: "bob@example.com" }, entryOf)).toBeUndefined();
    });
});
