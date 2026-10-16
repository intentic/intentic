import { RAW_ROUTE_LIST } from "../../protocol/raw/raw-routes.js";
import { SANDBOX_ROUTES, sandboxRouteFor } from "../../index.js";
import { type OrgPolicy, OrgPolicySchema, orgPinnedGroups, orgUnknownPins } from "../../schemas/organisation.js";
import { ORG_BOUND_ROUTES, ORG_SECTION_ROUTES, orgLockRefusal, orgPinRefusal, orgSectionOfRoute } from "../org-locks.js";

const policy = (sections: OrgPolicy["sections"]): OrgPolicy => ({ orgId: "org-1", orgName: "Urząd Gminy", version: 3, sections });

describe("org locks", () => {
    it("names only routes that exist, and never a read as a change", () => {
        const known = new Map([...SANDBOX_ROUTES, ...RAW_ROUTE_LIST].map((route) => [route.name, route.method]));
        for (const [section, routes] of Object.entries(ORG_SECTION_ROUTES)) {
            for (const name of routes.changes) {
                expect({ section, name, method: known.get(name) }).toEqual({ section, name, method: expect.not.stringMatching(/^(GET|HEAD)$/) });
            }
            for (const name of "reveals" in routes ? routes.reveals : []) {
                expect({ section, name, known: known.has(name) }).toEqual({ section, name, known: true });
            }
        }
    });

    it("lets everything through for a personal sandbox", () => {
        expect(orgLockRefusal(undefined, "settings.set")).toBeUndefined();
        expect(orgLockRefusal(undefined, "secrets.reveal")).toBeUndefined();
    });

    it("refuses a change to a locked section and names the organisation", () => {
        const refused = orgLockRefusal(policy({ agent: "locked" }), "settings.set");
        expect(refused).toMatchObject({ reason: "org-locked", section: "agent", org: "Urząd Gminy" });
        expect(orgLockRefusal(policy({ agent: "locked" }), "secrets.set")).toBeUndefined();
    });

    it("keeps reveals open while locked and refuses them once hidden", () => {
        expect(orgLockRefusal(policy({ secrets: "locked" }), "secrets.reveal")).toBeUndefined();
        expect(orgLockRefusal(policy({ secrets: "locked" }), "secrets.set")).toMatchObject({ section: "secrets" });
        expect(orgLockRefusal(policy({ secrets: "hidden" }), "secrets.reveal")).toMatchObject({ section: "secrets" });
    });

    it("leaves a person's own exits open whatever the policy", () => {
        const everything = policy({ access: "hidden", agent: "hidden" });
        expect(orgLockRefusal(everything, "DELETE /members/self")).toBeUndefined();
        expect(orgLockRefusal(everything, "settings.confirmAiLiteracy")).toBeUndefined();
        expect(orgLockRefusal(everything, "secrets.request")).toBeUndefined();
    });

    it("resolves a concrete request to its section through the route table", () => {
        expect(orgSectionOfRoute(sandboxRouteFor("POST", "/members")?.name ?? "")).toBe("access");
        expect(orgSectionOfRoute(sandboxRouteFor("DELETE", "/members/self")?.name ?? "")).toBeUndefined();
        expect(orgSectionOfRoute(sandboxRouteFor("PUT", "/secrets/gates/OPENAI_KEY")?.name ?? "")).toBe("secrets");
        expect(orgSectionOfRoute(sandboxRouteFor("POST", "/system/update/auto")?.name ?? "")).toBe("updates");
    });

    it("names only bound-only routes that exist and change something", () => {
        const known = new Map([...SANDBOX_ROUTES, ...RAW_ROUTE_LIST].map((route) => [route.name, route.method]));
        for (const name of ORG_BOUND_ROUTES) {
            expect({ name, method: known.get(name) }).toEqual({ name, method: expect.not.stringMatching(/^(GET|HEAD)$/) });
        }
    });

    it("refuses closing the sandbox to every browser on any bound sandbox, an all-open policy included", () => {
        expect(orgLockRefusal(policy({}), "POST /system/access/disable")).toMatchObject({ reason: "org-locked", section: "access", org: "Urząd Gminy" });
        expect(orgLockRefusal(policy({ access: "open" }), "POST /system/access/disable")).toMatchObject({ section: "access" });
        expect(orgLockRefusal(undefined, "POST /system/access/disable")).toBeUndefined();
    });

    it("reads pinned preset groups it knows in the contract's order, and reports the ones it does not", () => {
        const pinned = OrgPolicySchema.parse({ orgId: "o", orgName: "O", version: 1, preset: ["judge", "telepathy", "privacy"] });
        expect(orgPinnedGroups(pinned)).toEqual(["privacy", "judge"]);
        expect(orgUnknownPins(pinned)).toEqual(["telepathy"]);
        expect(orgPinnedGroups(OrgPolicySchema.parse({ orgId: "o", orgName: "O", version: 1 }))).toEqual([]);
        expect(orgPinnedGroups(undefined)).toEqual([]);
    });

    it("names the organisation and the items a refused pinned write would have loosened", () => {
        expect(orgPinRefusal({ orgName: "Urząd Gminy" }, ["privacy.mode", "retention.transcriptDays"])).toEqual({
            error: "Urząd Gminy requires privacy.mode, retention.transcriptDays to stay as it set them; ask your organisation's admin to change it",
            reason: "org-pinned",
            items: ["privacy.mode", "retention.transcriptDays"],
            org: "Urząd Gminy",
        });
    });

    it("takes the people list only as sha256 digests", () => {
        const base = { orgId: "o", orgName: "O", version: 1, membersOnly: true };
        expect(OrgPolicySchema.safeParse({ ...base, people: ["a".repeat(64)] }).success).toBe(true);
        expect(OrgPolicySchema.safeParse({ ...base, people: ["clerk@gmina.test"] }).success).toBe(false);
    });

    it("reads a section a policy leaves out as open, and refuses an unknown mode", () => {
        expect(OrgPolicySchema.parse({ orgId: "o", orgName: "O", version: 1 }).sections).toEqual({});
        expect(OrgPolicySchema.safeParse({ orgId: "o", orgName: "O", version: 1, sections: { agent: "sealed" } }).success).toBe(false);
    });
});
