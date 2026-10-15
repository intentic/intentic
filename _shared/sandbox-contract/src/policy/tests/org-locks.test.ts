import { RAW_ROUTE_LIST, SANDBOX_ROUTES, sandboxRouteFor } from "../../index.js";
import { type OrgPolicy, OrgPolicySchema } from "../../schemas/organisation.js";
import { ORG_SECTION_ROUTES, orgLockRefusal, orgSectionOfRoute } from "../org-locks.js";

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

    it("reads a section a policy leaves out as open, and refuses an unknown mode", () => {
        expect(OrgPolicySchema.parse({ orgId: "o", orgName: "O", version: 1 }).sections).toEqual({});
        expect(OrgPolicySchema.safeParse({ orgId: "o", orgName: "O", version: 1, sections: { agent: "sealed" } }).success).toBe(false);
    });
});
