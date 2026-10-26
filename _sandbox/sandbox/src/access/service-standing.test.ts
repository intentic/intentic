import type { AccessProfile } from "@intentic/sandbox-contract/schemas/access-profiles";
import type { Service } from "@intentic/sandbox-contract/schemas/services";
import type { Member } from "../auth/auth.js";
import { memoryAccessProfiles, memoryMembersStore, memoryServicesStore } from "../harness/route-stores.testing.js";
import { serviceStanding } from "./service-standing.js";

// A service may run while its steward, its record and its profile all stand; its run is born inside the steward's areas
// held under the profile's.

const OWNER = "ada@example.com";

const roster: Member[] = [
    { email: "bob@example.com", role: "collaborator", areas: ["site", "docs"] },
    { email: "vic@example.com", role: "viewer" },
];
const profiles: AccessProfile[] = [{ id: "site-only", areas: ["site", "shop"] }];
const OWNERS: Service = { id: "owners", steward: OWNER, profile: "site-only" };
const BOBS: Service = { id: "bobs", steward: "bob@example.com", profile: "site-only" };
const BOB_PLAIN: Service = { id: "bob-plain", steward: "bob@example.com" };
const services: Service[] = [
    OWNERS,
    BOBS,
    BOB_PLAIN,
    { id: "viewers", steward: "vic@example.com" },
    { id: "orphan", label: "Orphan", steward: "gone@example.com" },
    { id: "lost", label: "Lost", steward: OWNER, profile: "deleted" },
];

const deps = {
    services: memoryServicesStore(services),
    accessProfiles: memoryAccessProfiles(profiles),
    members: memoryMembersStore(roster),
    ownerEmail: async () => OWNER,
};

test("the owner's service runs inside its profile's areas", async () => {
    await expect(serviceStanding(deps, "owners")).resolves.toEqual({ ok: true, service: OWNERS, areas: ["site", "shop"] });
});

test("a member's service runs inside the areas both the member and the profile hold, or the member's alone", async () => {
    await expect(serviceStanding(deps, "bobs")).resolves.toEqual({ ok: true, service: BOBS, areas: ["site"] });
    await expect(serviceStanding(deps, "bob-plain")).resolves.toEqual({ ok: true, service: BOB_PLAIN, areas: ["site", "docs"] });
});

test("a service that is gone, a steward who left or does not run agents, and a lost profile are each refused with why", async () => {
    await expect(serviceStanding(deps, "ghost")).resolves.toEqual({
        ok: false,
        reason: `It runs as the service "ghost", which this sandbox no longer has: point it at another service, or write that one again on Sandbox ▸ Access ▸ Programs.`,
    });
    await expect(serviceStanding(deps, "orphan")).resolves.toEqual({
        ok: false,
        reason: `It runs as the service "Orphan", which acts for gone@example.com, who no longer has access to this sandbox: give it a new steward on Sandbox ▸ Access ▸ Programs.`,
    });
    await expect(serviceStanding(deps, "viewers")).resolves.toEqual({
        ok: false,
        reason: `It runs as the service "viewers", which acts for vic@example.com, who does not run agents here: give it a steward who does on Sandbox ▸ Access ▸ Programs.`,
    });
    await expect(serviceStanding(deps, "lost")).resolves.toEqual({
        ok: false,
        reason: `It runs as the service "Lost", whose access profile "deleted" no longer exists: give the service another on Sandbox ▸ Access ▸ Programs.`,
    });
});
