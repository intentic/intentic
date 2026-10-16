import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuditEvent } from "@intentic/sandbox-contract/schemas/audit";
import type { OrgPolicy } from "@intentic/sandbox-contract/schemas/organisation";
import { createApp } from "../app.js";
import { fileMembersStore, membersDocument } from "../auth/auth.js";
import { services } from "../harness/route-services.testing.js";
import { createLogger } from "../logger.js";
import { testConfig } from "../env.config.testing.js";
import { createOrgPolicyHolder } from "./org-policy.js";
import { fencedMembers, orgAdmits, orgPersonDigest, reconcileOrgRoster } from "./org-roster.js";

/* A LEAVER: an organisation that keeps its sandboxes to its own people removes a person from every bound sandbox's
 * roster by removing them from the organisation. Read-time first (the roster as the daemon reads it no longer lists
 * them, so every door that asks it refuses them), then the file and what their browsers hold. Nobody in the sandbox
 * acts, and the leaver is not asked. */

const membersOnly = (people: readonly string[], version = 1): OrgPolicy => ({
    orgId: "org-1",
    orgName: "Urząd Gminy",
    version,
    sections: {},
    membersOnly: true,
    people: people.map((email) => orgPersonDigest("org-1", email)),
});

const roster = async () => {
    const file = fileMembersStore(join(mkdtempSync(join(tmpdir(), "org-roster-")), membersDocument.path));
    await file.add("clerk@gmina.test", { role: "viewer" });
    await file.add("leaver@gmina.test", { role: "viewer" });
    return file;
};

const holder = async (policy: OrgPolicy | undefined) => {
    const orgPolicy = createOrgPolicyHolder({ authRoot: mkdtempSync(join(tmpdir(), "org-roster-")), logger: createLogger(testConfig) });
    if (policy !== undefined) {
        await orgPolicy.accept(policy);
    }
    return orgPolicy;
};

test("the people list is digests salted by the organisation, and fences only when the policy says so and sends one", () => {
    expect(orgPersonDigest("org-1", " Clerk@Gmina.test ")).toBe(orgPersonDigest("org-1", "clerk@gmina.test"));
    expect(orgPersonDigest("org-1", "clerk@gmina.test")).not.toBe(orgPersonDigest("org-2", "clerk@gmina.test"));
    expect(orgPersonDigest("org-1", "clerk@gmina.test")).toMatch(/^[0-9a-f]{64}$/u);
    expect(orgAdmits(undefined, "anyone@x.test")).toBe(true);
    expect(orgAdmits({ ...membersOnly([]), membersOnly: false }, "anyone@x.test")).toBe(true);
    expect(orgAdmits({ ...membersOnly([]), people: undefined }, "anyone@x.test")).toBe(true);
    expect(orgAdmits(membersOnly(["clerk@gmina.test"]), "CLERK@gmina.test")).toBe(true);
    expect(orgAdmits(membersOnly(["clerk@gmina.test"]), "leaver@gmina.test")).toBe(false);
});

test("the roster as the daemon reads it leaves out a person the organisation no longer lists, at once", async () => {
    const file = await roster();
    const orgPolicy = await holder(membersOnly(["clerk@gmina.test", "leaver@gmina.test"]));
    const members = fencedMembers(file, orgPolicy);
    expect((await members.list()).map((member) => member.email)).toEqual(["clerk@gmina.test", "leaver@gmina.test"]);
    await orgPolicy.accept(membersOnly(["clerk@gmina.test"], 2));
    expect((await members.list()).map((member) => member.email)).toEqual(["clerk@gmina.test"]);
    // A personal sandbox's roster reads as its file says.
    expect((await fencedMembers(file, await holder(undefined)).list()).map((member) => member.email)).toEqual(["clerk@gmina.test", "leaver@gmina.test"]);
});

test("a policy that arrives takes the leaver off the roster file, closes what they hold and says so in the audit trail", async () => {
    const file = await roster();
    const revoked: string[] = [];
    const recorded: AuditEvent[] = [];
    const deps = { members: file, revoke: (email: string) => void revoked.push(email), record: (event: AuditEvent) => void recorded.push(event), logger: createLogger(testConfig) };
    expect(await reconcileOrgRoster(deps, membersOnly(["clerk@gmina.test"]))).toEqual(["leaver@gmina.test"]);
    expect((await file.list()).map((member) => member.email)).toEqual(["clerk@gmina.test"]);
    expect(revoked).toEqual(["leaver@gmina.test"]);
    expect(recorded).toEqual([
        {
            actor: { kind: "system", reason: "organisation policy" },
            action: "member.revoke",
            target: "leaver@gmina.test",
            details: { org: "Urząd Gminy", reason: "not a member of the organisation" },
        },
    ]);
    // Nothing to do the second time, and nothing at all without the fence.
    expect(await reconcileOrgRoster(deps, membersOnly(["clerk@gmina.test"]))).toEqual([]);
    expect(await reconcileOrgRoster(deps, { ...membersOnly([]), membersOnly: false })).toEqual([]);
    expect(await reconcileOrgRoster(deps, undefined)).toEqual([]);
    expect((await file.list()).map((member) => member.email)).toEqual(["clerk@gmina.test"]);
});

test("the holder tells a listener the policy boot read, then each one after", async () => {
    const orgPolicy = await holder(membersOnly(["clerk@gmina.test"]));
    const seen: (number | undefined)[] = [];
    orgPolicy.onChange((policy) => void seen.push(policy?.version));
    await orgPolicy.current();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await orgPolicy.accept(membersOnly(["clerk@gmina.test"], 2));
    await orgPolicy.accept(null);
    expect(seen).toEqual([1, 2, undefined]);
});

test("a grant to someone the organisation does not list is refused, and one to a member goes through", async () => {
    const file = await roster();
    const orgPolicy = await holder(membersOnly(["clerk@gmina.test", "new@gmina.test"]));
    const app = createApp(services({ orgPolicy, members: fencedMembers(file, orgPolicy) }));
    const grant = (email: string) =>
        app.request("/members", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, role: "viewer" }) });
    const outsider = await grant("outsider@example.com");
    expect(outsider.status).toBe(403);
    expect(await outsider.json()).toMatchObject({ reason: "org-members-only", org: "Urząd Gminy" });
    const member = await grant("new@gmina.test");
    expect(member.status).toBe(200);
    expect((await file.list()).map((row) => row.email)).toContain("new@gmina.test");
});
