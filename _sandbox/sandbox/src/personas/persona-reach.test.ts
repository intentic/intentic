import type { Area, Persona } from "@intentic/sandbox-contract";
import { describe, test, expect } from "bun:test";
import type { ProvenCaller } from "../auth/auth.js";
import { memoryAreasStore, memoryPersonasStore } from "../harness/route-stores.testing.js";
import { reachablePersonas, refuseUnlessReachable } from "./persona-reach.js";

// Which personas a fence hands over, resolved through the manifest. The rule itself is the contract's persona-home
// test; what is pinned here is that area ids become folders through the LIVE manifest, and what each tier is refused.

const PERSONAS: readonly Persona[] = [
    { id: "helper", capabilities: [], workspace: { startIn: "support" } },
    { id: "books", capabilities: [], workspace: { startIn: "finance" } },
    // Homed nowhere: an everywhere persona, which only an unfenced caller reaches.
    { id: "anyone", capabilities: [] },
];

const AREAS: readonly Area[] = [
    { id: "support", folders: ["support"] },
    { id: "finance", folders: ["finance"] },
    { id: "empty", folders: ["marketing"] },
];

const services = (personas: readonly Persona[] = PERSONAS) => ({
    personas: memoryPersonasStore([...personas]),
    areas: memoryAreasStore([...AREAS]),
});

const caller = (role: ProvenCaller["role"], areas?: readonly string[]): ProvenCaller => ({
    email: "dee@example.com",
    role,
    methods: ["google"],
    ...(areas === undefined ? {} : { areas }),
});

const ids = async (areas?: readonly string[]): Promise<string[]> => (await reachablePersonas(services(), areas)).map((persona) => persona.id);

describe("reachablePersonas", () => {
    test("an unfenced holder reaches every persona, the everywhere one included", async () => {
        await expect(ids(undefined)).resolves.toEqual(["helper", "books", "anyone"]);
    });

    test("a fenced holder reaches the personas homed in the folders its areas name", async () => {
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
    test("a caller may wear a persona their areas reach, and not one they do not", async () => {
        await expect(refuseUnlessReachable(services(), caller("collaborator", ["support"]), "helper")).resolves.toBeUndefined();
        await expect(refuseUnlessReachable(services(), caller("collaborator", ["support"]), "books")).rejects.toThrow(
            /"books" does not work in the part of the workspace you hold; yours are: helper/,
        );
    });

    test("a guest names a persona or is refused, and the refusal offers what it does hold", async () => {
        await expect(refuseUnlessReachable(services(), caller("guest", ["support"]), "helper")).resolves.toBeUndefined();
        await expect(refuseUnlessReachable(services(), caller("guest", ["support"]), undefined)).rejects.toThrow(
            /a guest speaks through one of its assistants: yours are: helper/,
        );
        await expect(refuseUnlessReachable(services(), caller("guest", ["empty"]), undefined)).rejects.toThrow(/no assistant lives in the part/);
    });

    test("an unfenced caller, and one naming no persona at all, are asked nothing", async () => {
        await expect(refuseUnlessReachable(services(), caller("owner"), "books")).resolves.toBeUndefined();
        await expect(refuseUnlessReachable(services(), caller("collaborator"), undefined)).resolves.toBeUndefined();
        await expect(refuseUnlessReachable(services(), caller("collaborator", ["support"]), undefined)).resolves.toBeUndefined();
        await expect(refuseUnlessReachable(services(), undefined, "books")).resolves.toBeUndefined();
    });
});
