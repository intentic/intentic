import type { Area, Persona } from "@intentic/sandbox-contract";
import { describe, expect, test } from "vitest";
import type { ProvenCaller } from "../auth/auth.js";
import { memoryAreasStore, memoryPersonasStore } from "../harness/route-stores.testing.js";
import { reachableCards, refuseUnlessReachable } from "./persona-reach.js";

// Which cards a fence hands over, resolved through the manifest. The rule itself is the contract's persona-home
// test; what is pinned here is that area ids become folders through the LIVE manifest, and what each tier is refused.

const CARDS: readonly Persona[] = [
    { id: "helper", capabilities: [], workspace: { startIn: "support" } },
    { id: "books", capabilities: [], workspace: { startIn: "finance" } },
    // Homed nowhere: an everywhere card, which only an unfenced caller reaches.
    { id: "anyone", capabilities: [] },
];

const AREAS: readonly Area[] = [
    { id: "support", folders: ["support"] },
    { id: "finance", folders: ["finance"] },
    { id: "empty", folders: ["marketing"] },
];

const services = (cards: readonly Persona[] = CARDS) => ({
    personas: memoryPersonasStore([...cards]),
    areas: memoryAreasStore([...AREAS]),
});

const caller = (role: ProvenCaller["role"], areas?: readonly string[]): ProvenCaller => ({
    email: "dee@example.com",
    role,
    methods: ["google"],
    ...(areas === undefined ? {} : { areas }),
});

const ids = async (areas?: readonly string[]): Promise<string[]> => (await reachableCards(services(), areas)).map((card) => card.id);

describe("reachableCards", () => {
    test("an unfenced holder reaches every card, the everywhere one included", async () => {
        await expect(ids(undefined)).resolves.toEqual(["helper", "books", "anyone"]);
    });

    test("a fenced holder reaches the cards homed in the folders its areas name", async () => {
        await expect(ids(["support"])).resolves.toEqual(["helper"]);
        await expect(ids(["support", "finance"])).resolves.toEqual(["helper", "books"]);
        await expect(ids(["empty"])).resolves.toEqual([]);
    });

    // Fail-shut: an id the manifest no longer has contributes no folder, so it narrows its holder rather than
    // releasing them.
    test("an area nobody wrote hands over nothing rather than everything", async () => {
        await expect(ids(["gone"])).resolves.toEqual([]);
    });
});

describe("refuseUnlessReachable", () => {
    test("a caller may wear a card their areas reach, and not one they do not", async () => {
        await expect(refuseUnlessReachable(services(), caller("collaborator", ["support"]), "helper")).resolves.toBeUndefined();
        await expect(refuseUnlessReachable(services(), caller("collaborator", ["support"]), "books")).rejects.toThrow(
            /"books" does not work in the part of the workspace you hold; yours are: helper/,
        );
    });

    test("a desk names a card or is refused, and the refusal offers what it does hold", async () => {
        await expect(refuseUnlessReachable(services(), caller("desk", ["support"]), "helper")).resolves.toBeUndefined();
        await expect(refuseUnlessReachable(services(), caller("desk", ["support"]), undefined)).rejects.toThrow(
            /a desk speaks through one of its assistants: yours are: helper/,
        );
        await expect(refuseUnlessReachable(services(), caller("desk", ["empty"]), undefined)).rejects.toThrow(/no assistant lives in the part/);
    });

    test("an unfenced caller, and one naming no card at all, are asked nothing", async () => {
        await expect(refuseUnlessReachable(services(), caller("owner"), "books")).resolves.toBeUndefined();
        await expect(refuseUnlessReachable(services(), caller("collaborator"), undefined)).resolves.toBeUndefined();
        await expect(refuseUnlessReachable(services(), caller("collaborator", ["support"]), undefined)).resolves.toBeUndefined();
        await expect(refuseUnlessReachable(services(), undefined, "books")).resolves.toBeUndefined();
    });
});
