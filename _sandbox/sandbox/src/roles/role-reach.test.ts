import type { Area } from "@intentic/sandbox-contract/schemas/areas";
import { FULL_ACCESS_ROLE, NO_ACCOUNTS_ROLE, type Role } from "@intentic/sandbox-contract/schemas/roles";
import type { ProvenCaller } from "../auth/auth.js";
import { memoryAreasStore, memoryRolesStore } from "../harness/route-stores.testing.js";
import { assistantsRefusal, reachableRoles, refuseUnlessReachable } from "./role-reach.js";

// Which roles a fence hands over, resolved through the manifest. The rule itself is the contract's role-home
// test; what is pinned here is that area ids become folders through the LIVE manifest, and what each tier is refused.

const ROLES: readonly Role[] = [
    { id: "helper", capabilities: [], workspace: { startIn: "support" } },
    { id: "books", capabilities: [], workspace: { startIn: "finance" } },
    // Homed nowhere: an everywhere role, which only an unfenced caller reaches.
    { id: "anyone", capabilities: [] },
];

const AREAS: readonly Area[] = [
    { id: "support", folders: ["support"] },
    { id: "finance", folders: ["finance"] },
    { id: "empty", folders: ["marketing"] },
];

const services = (roles: readonly Role[] = ROLES) => ({
    roles: memoryRolesStore([...roles]),
    areas: memoryAreasStore([...AREAS]),
});

const caller = (role: ProvenCaller["tier"], areas?: readonly string[]): ProvenCaller => ({
    email: "dee@example.com",
    tier: role,
    methods: ["google"],
    ...(areas === undefined ? {} : { areas }),
});

const ids = async (areas?: readonly string[]): Promise<string[]> => (await reachableRoles(services(), areas)).map((role) => role.id);

describe("reachableRoles", () => {
    test("an unfenced holder reaches every role, the everywhere one included", async () => {
        await expect(ids(undefined)).resolves.toEqual(["helper", "books", "anyone"]);
    });

    test("a fenced holder reaches the roles homed in the folders its areas name", async () => {
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
    test("a caller may wear a role their areas reach, and not one they do not", async () => {
        await expect(refuseUnlessReachable(services(), caller("collaborator", ["support"]), "helper")).resolves.toBeUndefined();
        await expect(refuseUnlessReachable(services(), caller("collaborator", ["support"]), "books")).rejects.toThrow(
            /"books" does not work in the part of the workspace you hold; yours are: helper/,
        );
    });

    test("a guest names a role or is refused, and the refusal offers what it does hold", async () => {
        await expect(refuseUnlessReachable(services(), caller("guest", ["support"]), "helper")).resolves.toBeUndefined();
        await expect(refuseUnlessReachable(services(), caller("guest", ["support"]), undefined)).rejects.toThrow(
            /a guest speaks through one of its assistants: yours are: helper/,
        );
        await expect(refuseUnlessReachable(services(), caller("guest", ["empty"]), undefined)).rejects.toThrow(/no assistant lives in the part/);
    });

    // A built-in lives nowhere, so no fence could hold it; a fenced collaborator wears it as they wear no role at all,
    // inside their own folders. A guest is handed neither: Full access is every account, No accounts the whole toolbox.
    test("anyone but a guest may wear a built-in, fenced or not", async () => {
        for (const builtIn of [FULL_ACCESS_ROLE, NO_ACCOUNTS_ROLE]) {
            await expect(refuseUnlessReachable(services(), caller("collaborator", ["support"]), builtIn)).resolves.toBeUndefined();
            await expect(refuseUnlessReachable(services(), caller("owner"), builtIn)).resolves.toBeUndefined();
            await expect(refuseUnlessReachable(services(), caller("guest", ["support"]), builtIn)).rejects.toThrow(
                /a guest speaks through one of its assistants: yours are: helper/,
            );
        }
    });

    test("an unfenced caller, and one naming no role at all, are asked nothing", async () => {
        await expect(refuseUnlessReachable(services(), caller("owner"), "books")).resolves.toBeUndefined();
        await expect(refuseUnlessReachable(services(), caller("collaborator"), undefined)).resolves.toBeUndefined();
        await expect(refuseUnlessReachable(services(), caller("collaborator", ["support"]), undefined)).resolves.toBeUndefined();
        await expect(refuseUnlessReachable(services(), undefined, "books")).resolves.toBeUndefined();
    });
});

describe("a chatting guest's own assistants", () => {
    const AREAS_ROLES: readonly Role[] = [...ROLES, { id: "desk", capabilities: [], workspace: { startIn: "support/desk" } }];

    test("narrow what the areas hold, and never add one outside them", async () => {
        const reached = await reachableRoles(services(AREAS_ROLES), ["support"], ["desk", "books"]);
        expect(reached.map((role) => role.id)).toEqual(["desk"]);
    });

    test("are refused when one is unknown or works outside the areas", async () => {
        await expect(assistantsRefusal(services(AREAS_ROLES), ["support"], ["desk"])).resolves.toBeUndefined();
        await expect(assistantsRefusal(services(AREAS_ROLES), ["support"], ["nobody"])).resolves.toBe("no such assistant: nobody");
        await expect(assistantsRefusal(services(AREAS_ROLES), ["support"], ["books"])).resolves.toBe(
            "books does not work in those areas: a guest's chat works inside the guest's own areas, so an assistant has to start in one of them",
        );
    });

    test("hold a guest to the ones listed when it names a role", async () => {
        const guest: ProvenCaller = { ...caller("guest", ["support"]), assistants: ["desk"] };
        await expect(refuseUnlessReachable(services(AREAS_ROLES), guest, "desk")).resolves.toBeUndefined();
        await expect(refuseUnlessReachable(services(AREAS_ROLES), guest, "helper")).rejects.toThrow(/"helper" does not work in the part of the workspace you hold; yours are: desk/);
    });
});
