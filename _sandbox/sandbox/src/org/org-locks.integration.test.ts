import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MemberRole, OrgPolicy } from "@intentic/sandbox-contract";
import { createApp } from "../app.js";
import { createLogger } from "../logger.js";
import { clientFor, errorCode, proven, rejectForbidden } from "../harness/route-client.testing.js";
import { services } from "../harness/route-services.testing.js";
import { testConfig } from "../testing.js";
import { createOrgPolicyHolder, ORG_POLICY_FILE, type OrgPolicyFetch } from "./org-policy.js";

/* AN ORGANISATION'S LOCK, held to over the daemon's own HTTP surface the way the editor and the agent reach it: a
 * locked section refuses every change, the sandbox owner's included; a personal sandbox is exactly as it was; a new
 * edition applies, an old one does not, and losing the platform never loosens what is held. */

const policy = (version: number, sections: OrgPolicy["sections"]): OrgPolicy => ({ orgId: "org-1", orgName: "Urząd Gminy", version, sections });

const daemon = (options: { readonly role?: MemberRole; readonly fetch?: OrgPolicyFetch } = {}) => {
    const authRoot = mkdtempSync(join(tmpdir(), "org-locks-"));
    const orgPolicy = createOrgPolicyHolder({ authRoot, logger: createLogger(testConfig), fetch: options.fetch });
    const caller = proven("owner@gmina.test", options.role ?? "owner");
    const app = createApp(services({ orgPolicy, auth: { authorize: async () => caller, authorizeOwner: rejectForbidden } }));
    return { app, orgPolicy, authRoot, client: clientFor(app, { bearer: "owner" }) };
};

test("a personal sandbox holds no policy and its owner changes what they like", async () => {
    const { client } = daemon();
    expect(await client.org.policy()).toEqual({ bound: false });
    expect(await client.secrets.set({ key: "API_KEY", value: "x" })).toEqual({ ok: true });
});

test("a locked section refuses the sandbox owner's change, and says who holds it", async () => {
    const { app, client, orgPolicy } = daemon();
    await orgPolicy.accept(policy(1, { secrets: "locked" }));
    expect(await errorCode(client.secrets.set({ key: "API_KEY", value: "x" }))).toBe("FORBIDDEN");
    const answer = await app.request("/secrets", {
        method: "POST",
        headers: { authorization: "Bearer owner", "content-type": "application/json" },
        body: JSON.stringify({ key: "API_KEY", value: "x" }),
    });
    expect(answer.status).toBe(403);
    expect(await answer.json()).toMatchObject({ reason: "org-locked", section: "secrets", org: "Urząd Gminy" });
    // Reading is untouched, and so is a section the policy does not name.
    expect(await client.secrets.list()).toEqual({ keys: [] });
    expect(await client.org.policy()).toMatchObject({ bound: true, policy: { version: 1, sections: { secrets: "locked" } } });
});

test("hiding a section also stops a value being shown, which locking alone does not", async () => {
    const { client, orgPolicy } = daemon();
    expect(await client.secrets.set({ key: "API_KEY", value: "x" })).toEqual({ ok: true });
    await orgPolicy.accept(policy(1, { secrets: "locked" }));
    expect(await client.secrets.reveal({ key: "API_KEY" })).toEqual({ value: "x" });
    await orgPolicy.accept(policy(2, { secrets: "hidden" }));
    expect(await errorCode(client.secrets.reveal({ key: "API_KEY" }))).toBe("FORBIDDEN");
});

test("the lock holds without a signed-in caller too: the owner's own tools and the agent go through the same door", async () => {
    const authRoot = mkdtempSync(join(tmpdir(), "org-locks-"));
    const orgPolicy = createOrgPolicyHolder({ authRoot, logger: createLogger(testConfig) });
    const client = clientFor(createApp(services({ orgPolicy })));
    expect(await client.areas.save({ id: "finance", folders: ["finance"] })).toEqual({ ok: true });
    await orgPolicy.accept(policy(1, { areas: "locked" }));
    expect(await errorCode(client.areas.save({ id: "finance", folders: ["finance", "payroll"] }))).toBe("FORBIDDEN");
});

test("a newer edition applies, an older one is ignored, and the platform's null unbinds", async () => {
    const { client, orgPolicy, authRoot } = daemon();
    await orgPolicy.accept(policy(2, { secrets: "locked" }));
    await orgPolicy.accept(policy(1, {}));
    expect(await errorCode(client.secrets.set({ key: "API_KEY", value: "x" }))).toBe("FORBIDDEN");
    await orgPolicy.accept(policy(3, { secrets: "open" }));
    expect(await client.secrets.set({ key: "API_KEY", value: "x" })).toEqual({ ok: true });
    await orgPolicy.accept(policy(4, { secrets: "locked" }));
    await orgPolicy.accept(null);
    expect(await client.org.policy()).toEqual({ bound: false });
    expect(existsSync(join(authRoot, ORG_POLICY_FILE))).toBe(false);
    expect(await client.secrets.set({ key: "API_KEY", value: "y" })).toEqual({ ok: true });
});

test("a restart keeps enforcing the last edition, and a platform that cannot be reached loosens nothing", async () => {
    const { orgPolicy, authRoot } = daemon();
    await orgPolicy.accept(policy(5, { personas: "hidden" }));
    const unreachable: OrgPolicyFetch = async () => {
        throw new Error("ECONNREFUSED");
    };
    const refusing: OrgPolicyFetch = async () => undefined;
    for (const fetch of [unreachable, refusing]) {
        const restarted = createOrgPolicyHolder({ authRoot, logger: createLogger(testConfig), fetch });
        await restarted.refresh();
        expect(await restarted.current()).toMatchObject({ version: 5, sections: { personas: "hidden" } });
    }
});

test("a refresh takes the platform's answer and tells it which edition is held", async () => {
    const asked: (number | undefined)[] = [];
    let answer: OrgPolicy | null = policy(1, { extensions: "locked" });
    const { orgPolicy, client } = daemon({
        fetch: async (applied) => {
            asked.push(applied);
            return { policy: answer };
        },
    });
    await orgPolicy.refresh();
    expect(await errorCode(client.extensions.setEnabled({ id: "intentic.maintenance", enabled: false }))).toBe("FORBIDDEN");
    answer = policy(2, {});
    await orgPolicy.refresh();
    expect(asked).toEqual([undefined, 1]);
    expect(await client.org.policy()).toMatchObject({ bound: true, policy: { version: 2, sections: {} } });
});
