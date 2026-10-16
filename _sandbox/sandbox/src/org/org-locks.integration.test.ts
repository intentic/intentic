import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MemberRole } from "@intentic/sandbox-contract/schemas/shared";
import type { OrgPolicy } from "@intentic/sandbox-contract/schemas/organisation";
import { createApp } from "../app.js";
import { createLogger } from "../logger.js";
import { clientFor, errorCode, proven, rejectForbidden } from "../harness/route-client.testing.js";
import { services } from "../harness/route-services.testing.js";
import { testConfig } from "../env.config.testing.js";
import { createOrgPolicyHolder, ORG_POLICY_FILE, type OrgPolicyFetch } from "./org-policy.js";

/* AN ORGANISATION'S LOCK, held to over the daemon's own HTTP surface the way the editor and the agent reach it: a
 * locked section refuses every change, the sandbox owner's included; a personal sandbox is exactly as it was; a new
 * edition applies, an old one does not, and losing the platform never loosens what is held. */

const policy = (version: number, sections: OrgPolicy["sections"]): OrgPolicy => ({ orgId: "org-1", orgName: "Urząd Gminy", version, sections });

// What a test's platform answers next: undefined is no answer at all (unreachable, refused).
interface PlatformAnswer {
    answer: OrgPolicy | null | undefined;
}

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

test("the platform's answer is the policy, an edition numbered below the held one included, and its null unbinds", async () => {
    const { client, orgPolicy, authRoot } = daemon();
    await orgPolicy.accept(policy(2, { secrets: "locked" }));
    expect(await errorCode(client.secrets.set({ key: "API_KEY", value: "x" }))).toBe("FORBIDDEN");
    // A platform restored from an older backup still governs its sandboxes.
    await orgPolicy.accept(policy(1, {}));
    expect(await client.secrets.set({ key: "API_KEY", value: "x" })).toEqual({ ok: true });
    await orgPolicy.accept(policy(4, { secrets: "locked" }));
    await orgPolicy.accept(null);
    expect(await client.org.policy()).toEqual({ bound: false });
    expect(existsSync(join(authRoot, ORG_POLICY_FILE))).toBe(false);
    expect(await client.secrets.set({ key: "API_KEY", value: "y" })).toEqual({ ok: true });
});

test("a held file edited to an edition far ahead of the platform's is replaced by the platform's next answer", async () => {
    const { authRoot } = daemon();
    // What phase 1 let outlive every later answer: a looser policy numbered past anything the platform will reach.
    writeFileSync(join(authRoot, ORG_POLICY_FILE), JSON.stringify({ policy: policy(999_999, {}), receivedAt: "2026-10-15T00:00:00.000Z" }));
    const asked: (number | undefined)[] = [];
    const restarted = createOrgPolicyHolder({
        authRoot,
        logger: createLogger(testConfig),
        fetch: async (applied) => {
            asked.push(applied);
            return { policy: policy(3, { secrets: "locked" }) };
        },
    });
    await restarted.refresh();
    expect(asked).toEqual([999_999]);
    expect(await restarted.current()).toMatchObject({ version: 3, sections: { secrets: "locked" } });
    expect(JSON.parse(readFileSync(join(authRoot, ORG_POLICY_FILE), "utf8"))).toMatchObject({ policy: { version: 3 } });
});

test("a held file that does not read holds every section read-only until the platform answers, reporting no edition", async () => {
    const authRoot = mkdtempSync(join(tmpdir(), "org-locks-"));
    // Readable JSON, but not a policy: an edition that is not a number. The name in it is still the one the refusal uses.
    writeFileSync(join(authRoot, ORG_POLICY_FILE), JSON.stringify({ policy: { orgId: "org-1", orgName: "Urząd Gminy", version: "seven", sections: {} } }));
    const asked: (number | undefined)[] = [];
    // What the platform answers: nothing yet, then a policy.
    const platform: PlatformAnswer = { answer: undefined };
    const orgPolicy = createOrgPolicyHolder({
        authRoot,
        logger: createLogger(testConfig),
        fetch: async (applied) => {
            asked.push(applied);
            return platform.answer === undefined ? undefined : { policy: platform.answer };
        },
    });
    const client = clientFor(createApp(services({ orgPolicy })));
    expect(await errorCode(client.areas.save({ id: "finance", folders: ["finance"] }))).toBe("FORBIDDEN");
    expect(await errorCode(client.secrets.set({ key: "API_KEY", value: "x" }))).toBe("FORBIDDEN");
    expect(await client.org.policy()).toMatchObject({ bound: true, provisional: true, policy: { orgName: "Urząd Gminy", sections: { agent: "locked", access: "locked" } } });
    // A platform that does not answer keeps the hold; its answer replaces it.
    await orgPolicy.refresh();
    expect(await errorCode(client.secrets.set({ key: "API_KEY", value: "x" }))).toBe("FORBIDDEN");
    platform.answer = policy(6, { areas: "locked" });
    await orgPolicy.refresh();
    expect(asked).toEqual([undefined, undefined]);
    expect(await client.secrets.set({ key: "API_KEY", value: "x" })).toEqual({ ok: true });
    expect(await errorCode(client.areas.save({ id: "finance", folders: ["finance"] }))).toBe("FORBIDDEN");
    expect(await client.org.policy()).toEqual({ bound: true, policy: policy(6, { areas: "locked" }), receivedAt: expect.any(String) });
});

test("with no held file, a covered change waits for the platform's first answer instead of passing as personal", async () => {
    const authRoot = mkdtempSync(join(tmpdir(), "org-locks-"));
    let release: (() => void) | undefined;
    const answered = new Promise<void>((resolve) => (release = resolve));
    const orgPolicy = createOrgPolicyHolder({
        authRoot,
        logger: createLogger(testConfig),
        fetch: async () => {
            await answered;
            return { policy: policy(2, { secrets: "locked" }) };
        },
    });
    const client = clientFor(createApp(services({ orgPolicy })));
    orgPolicy.start();
    try {
        // A route no lock covers does not wait.
        expect(await client.org.policy()).toEqual({ bound: false });
        const change = errorCode(client.secrets.set({ key: "API_KEY", value: "x" }));
        release?.();
        expect(await change).toBe("FORBIDDEN");
    } finally {
        orgPolicy.stop();
    }
});

test("a personal sandbox's first change after boot waits only for the platform's null", async () => {
    const authRoot = mkdtempSync(join(tmpdir(), "org-locks-"));
    const orgPolicy = createOrgPolicyHolder({ authRoot, logger: createLogger(testConfig), fetch: async () => ({ policy: null }) });
    const client = clientFor(createApp(services({ orgPolicy })));
    orgPolicy.start();
    try {
        expect(await client.secrets.set({ key: "API_KEY", value: "x" })).toEqual({ ok: true });
        expect(orgPolicy.waiting()).toBe(false);
    } finally {
        orgPolicy.stop();
    }
});

test("refreshes run one at a time, so a slow earlier answer never lands after a later one", async () => {
    const authRoot = mkdtempSync(join(tmpdir(), "org-locks-"));
    const answers = [
        { delay: 30, policy: policy(1, {}) },
        { delay: 0, policy: policy(2, { secrets: "locked" }) },
    ];
    const orgPolicy = createOrgPolicyHolder({
        authRoot,
        logger: createLogger(testConfig),
        fetch: async () => {
            const next = answers.shift();
            await new Promise((resolve) => setTimeout(resolve, next?.delay ?? 0));
            return { policy: next?.policy ?? null };
        },
    });
    await Promise.all([orgPolicy.refresh(), orgPolicy.refresh()]);
    expect(await orgPolicy.current()).toMatchObject({ version: 2, sections: { secrets: "locked" } });
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
