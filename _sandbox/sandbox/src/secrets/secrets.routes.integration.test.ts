import { STATE_DIR } from "@intentic/constants";
import type { Capability } from "@intentic/sandbox-contract/schemas/capabilities";

import { createApp } from "../app.js";

import { clientFor, errorCode, proven, rejectForbidden } from "../harness/route-client.testing.js";
import { services } from "../harness/route-services.testing.js";
import { memoryCapabilitiesStore } from "../capabilities/capabilities-slice.testing.js";
import { fakeDevices, fakeKeyring, pointerOf } from "./device/keyring.testing.js";
import { secretsSliceFake } from "./secrets-slice.testing.js";

// Drives the secrets routes over the daemon's HTTP surface the way the browser does; fakes and the client are shared
// from route-services.testing.ts and its siblings.

// Two secrets a person set, kept in the sandbox's own store the way the Secrets view's set keeps them.
const seeded = async (overrides: Parameters<typeof services>[0] = {}): Promise<ReturnType<typeof services>> => {
    const svc = services(overrides);
    await svc.sandboxSecrets.set("HOST_SSH_KEY", "pem-body-0001aa");
    await svc.sandboxSecrets.set("EXTRA_TOKEN", "extra-token-0002bb");
    return svc;
};

test("set / list / reveal / remove use the sandbox's own store", async () => {
    const client = clientFor(createApp(services()));
    expect(await client.secrets.set({ key: "CLOUDFLARE_API_TOKEN", value: "x" })).toEqual({ ok: true });
    expect(await client.secrets.list()).toEqual({ keys: ["CLOUDFLARE_API_TOKEN"] });
    expect(await client.secrets.reveal({ key: "CLOUDFLARE_API_TOKEN" })).toEqual({ value: "x" });
    expect(await client.secrets.remove({ key: "CLOUDFLARE_API_TOKEN" })).toEqual({ ok: true });
    expect(await client.secrets.list()).toEqual({ keys: [] });
    expect(await errorCode(client.secrets.remove({ key: "CLOUDFLARE_API_TOKEN" }))).toBe("NOT_FOUND");
    expect(await errorCode(client.secrets.reveal({ key: "CLOUDFLARE_API_TOKEN" }))).toBe("NOT_FOUND");
});

test("secrets.generate stores a random value under a new name and answers its length, never the value", async () => {
    const client = clientFor(createApp(services()));
    const made = await client.secrets.generate({ key: "SESSION_SECRET", bytes: 32, format: "hex" });
    expect(made).toEqual({ key: "SESSION_SECRET", length: 64, stored: "sandbox" });
    const { value } = await client.secrets.reveal({ key: "SESSION_SECRET" });
    expect(value).toMatch(/^[0-9a-f]{64}$/u);
    expect(JSON.stringify(made)).not.toContain(value);
    // Defaults: 32 bytes of hex, the shape most readers accept.
    expect(await client.secrets.generate({ key: "WEBHOOK_SECRET" })).toEqual({ key: "WEBHOOK_SECRET", length: 64, stored: "sandbox" });
});

test("secrets.generate refuses a name something already holds, rather than breaking whatever reads it", async () => {
    const client = clientFor(createApp(services()));
    await client.secrets.set({ key: "SESSION_SECRET", value: "the-one-in-use" });
    expect(await errorCode(client.secrets.generate({ key: "SESSION_SECRET" }))).toBe("CONFLICT");
    expect(await client.secrets.reveal({ key: "SESSION_SECRET" })).toEqual({ value: "the-one-in-use" });
});

test("a value too short to mask is flagged on its inventory row, and regenerate replaces only one a person set", async () => {
    const client = clientFor(createApp(services()));
    await client.secrets.set({ key: "ROOT_PASSWORD", value: "hunter2" });
    const row = async () => (await client.secrets.inventory()).entries.find((entry) => entry.key === "ROOT_PASSWORD");
    expect((await row())?.tooShort).toEqual(["ROOT_PASSWORD"]);
    const made = await client.secrets.regenerate({ key: "ROOT_PASSWORD" });
    expect(made).toEqual({ key: "ROOT_PASSWORD", length: 43, stored: "sandbox" });
    expect((await client.secrets.reveal({ key: "ROOT_PASSWORD" })).value).toMatch(/^[A-Za-z0-9]{43}$/u);
    expect((await row())?.tooShort).toBeUndefined();
    // Nothing a person set under that name: a connection's password changes on its site, not here.
    expect(await errorCode(client.secrets.regenerate({ key: "NOBODY_SET_THIS" }))).toBe("NOT_FOUND");
});

test("secrets.inventory merges the secrets a person set, credentialed capabilities, and provider accounts", async () => {
    const github: Capability = { id: "github", kind: "cli", config: { provider: "github", token: "gh-token" } };
    const client = clientFor(createApp(await seeded({ capabilities: memoryCapabilitiesStore([github]) })));
    const { entries } = await client.secrets.inventory();
    expect(entries).toEqual([
        { key: "HOST_SSH_KEY", kind: "env", status: "set", storedAt: `${STATE_DIR}/secrets/auth/sandbox-secrets.json`, revealable: true },
        { key: "EXTRA_TOKEN", kind: "env", status: "set", storedAt: `${STATE_DIR}/secrets/auth/sandbox-secrets.json`, revealable: true },
        {
            key: "github",
            kind: "capability",
            status: "connected",
            storedAt: `${STATE_DIR}/secrets/auth/capability-secrets.json`,
            revealable: true,
        },
        {
            key: "claude:default",
            kind: "provider",
            label: "Claude · Claude",
            status: "connected",
            storedAt: `${STATE_DIR}/secrets/auth/claude/default.json`,
            revealable: false,
        },
    ]);
});

test("secrets.inventory joins the use ledger: env keys by name, a capability by any of its fields", async () => {
    const github: Capability = { id: "github", kind: "cli", config: { provider: "github", token: "gh-token" } };
    const svc = await seeded({ capabilities: memoryCapabilitiesStore([github]) });
    await svc.secretUses.record({ name: "EXTRA_TOKEN", lane: "shell", detail: "curl https://api", at: 10 });
    await svc.secretUses.record({ name: "github/token", lane: "shell", detail: "gh api /user", at: 20 });
    const { entries } = await clientFor(createApp(svc)).secrets.inventory();
    const byKey = new Map(entries.map((entry) => [entry.key, entry]));
    expect(byKey.get("EXTRA_TOKEN")?.lastUse).toEqual({ at: 10, lane: "shell", detail: "curl https://api" });
    expect(byKey.get("github")?.lastUse).toEqual({ at: 20, lane: "shell", detail: "gh api /user" });
    expect(byKey.get("HOST_SSH_KEY")?.lastUse).toBeUndefined();
});

test("secrets.inventory joins each entry's host guard: the owner's by name, on or off, a connector's own by capability", async () => {
    const github: Capability = { id: "github", kind: "cli", config: { provider: "github", token: "gh-token" } };
    const svc = await seeded({
        capabilities: memoryCapabilitiesStore([github]),
        hostGuards: async () => [
            { subject: "EXTRA_TOKEN", kind: "secret", guard: true, hosts: ["api.example.com"], source: "owner" },
            { subject: "HOST_SSH_KEY", kind: "secret", guard: false, hosts: ["ssh.example.com"], source: "owner" },
            { subject: "github", kind: "capability", guard: true, hosts: ["api.github.com", "github.com"], source: "connector" },
        ],
    });
    const { entries } = await clientFor(createApp(svc)).secrets.inventory();
    const byKey = new Map(entries.map((entry) => [entry.key, entry]));
    expect(byKey.get("EXTRA_TOKEN")?.hosts).toEqual({ guard: true, list: ["api.example.com"], source: "owner" });
    expect(byKey.get("HOST_SSH_KEY")?.hosts).toEqual({ guard: false, list: ["ssh.example.com"], source: "owner" });
    expect(byKey.get("github")?.hosts).toEqual({ guard: true, list: ["api.github.com", "github.com"], source: "connector" });
});

// The request `secrets hosts … add` sends, raw: the subject in the path and again in the body, as the CLI writes it.
test("secrets.setHosts takes the body the secrets CLI sends, and hosts answers the guard it stored", async () => {
    const svc = services();
    const app = createApp(svc);
    await clientFor(app).secrets.set({ key: "GITHUB_TOKEN", value: "ghp_value" });
    const response = await app.request("/secrets/hosts/GITHUB_TOKEN", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ subject: "GITHUB_TOKEN", guard: true, hosts: ["api.github.com"], conversationId: "conv-cli" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ guard: true, hosts: ["api.github.com"] });
    expect(await clientFor(app).secrets.hosts()).toEqual({
        guards: [{ subject: "GITHUB_TOKEN", kind: "secret", guard: true, hosts: ["api.github.com"], source: "owner" }],
    });
});

test("secrets.inventory lists what a computer's keyring shares as device rows, and joins each sandbox secret's program list", async () => {
    const rog = fakeKeyring([
        pointerOf("VPN_PASSWORD", { mode: "each-use", programs: ["FortiClient.exe"], packages: ["com.fortinet.forticlient"], hosts: ["vpn.example.com"] }),
        pointerOf("KEPT_HERE"),
    ]);
    const slice = secretsSliceFake(fakeDevices({ rog }));
    await slice.keyringLink.refresh();
    const svc = services({ ...slice });
    const client = clientFor(createApp(svc));
    // A sandbox secret of the same name as a keyring's entry is the sandbox's: one row, its own.
    await client.secrets.set({ key: "KEPT_HERE", value: "kept-in-the-sandbox" });
    await svc.secretProgramGuards.set("KEPT_HERE", { programs: ["mstsc.exe"], packages: [], anyField: false });
    await svc.secretUses.record({ name: "VPN_PASSWORD", lane: "device", detail: "rog · FortiClient.exe", at: 30 });
    const { entries } = await client.secrets.inventory();
    const byKey = new Map(entries.map((entry) => [entry.key, entry]));
    expect(byKey.get("VPN_PASSWORD")).toEqual({
        key: "VPN_PASSWORD",
        kind: "device",
        status: "set",
        storedAt: "in the keyring on rog",
        revealable: false,
        device: { machine: "rog", mode: "each-use", online: true, locked: false, source: "keyring" },
        hosts: { guard: true, list: ["vpn.example.com"], source: "keyring" },
        programs: { programs: ["FortiClient.exe"], packages: ["com.fortinet.forticlient"], anyField: false, source: "keyring" },
        lastUse: { at: 30, lane: "device", detail: "rog · FortiClient.exe" },
    });
    expect([byKey.get("KEPT_HERE")?.kind, byKey.get("KEPT_HERE")?.programs]).toEqual(["env", { programs: ["mstsc.exe"], packages: [], anyField: false, source: "owner" }]);
    expect(entries.filter((entry) => entry.key === "KEPT_HERE")).toHaveLength(1);
    // Nothing of it is here to show, and the refusal says where it lives.
    await expect(client.secrets.reveal({ key: "VPN_PASSWORD" })).rejects.toThrow('"VPN_PASSWORD" is kept in the keyring on rog');
    expect(await errorCode(client.secrets.reveal({ key: "VPN_PASSWORD" }))).toBe("FORBIDDEN");
    expect(await errorCode(client.secrets.generate({ key: "VPN_PASSWORD" }))).toBe("CONFLICT");
});

test("secrets.inventory answers pre-scaffold with capability/provider entries only", async () => {
    const client = clientFor(createApp(services()));
    const { entries } = await client.secrets.inventory();
    expect(entries.map((entry) => entry.key)).toEqual(["claude:default"]);
});

test("secrets.reveal returns values to the operating tier and refuses lower roles", async () => {
    const client = clientFor(createApp(await seeded()));
    expect(await client.secrets.reveal({ key: "HOST_SSH_KEY" })).toEqual({ value: "pem-body-0001aa" });
    expect(await errorCode(client.secrets.reveal({ key: "GHOST" }))).toBe("NOT_FOUND");

    const maintainerClient = clientFor(
        createApp(
            await seeded({
                auth: { authorize: async () => proven("m@example.com", "maintainer"), authorizeOwner: rejectForbidden },
            }),
        ),
    );
    expect(await maintainerClient.secrets.reveal({ key: "HOST_SSH_KEY" })).toEqual({ value: "pem-body-0001aa" });

    const collaboratorClient = clientFor(
        createApp(
            await seeded({
                auth: { authorize: async () => proven("c@example.com", "collaborator"), authorizeOwner: rejectForbidden },
            }),
        ),
    );
    expect(await errorCode(collaboratorClient.secrets.reveal({ key: "HOST_SSH_KEY" }))).toBe("FORBIDDEN");
});

// The lost-update regression: `set` is read-modify-write, so unserialized, two overlapping calls would both read the
// pre-write file and the second erase the first one's key, while both answered ok.
test("concurrent secrets.set calls all land, none clobbering a write still in flight", async () => {
    const client = clientFor(createApp(await seeded()));
    await Promise.all([
        client.secrets.set({ key: "STRIPE_KEY", value: "sk_live_1" }),
        client.secrets.set({ key: "OPENAI_KEY", value: "sk-oai-2" }),
        client.secrets.set({ key: "SENTRY_DSN", value: "https://sentry" }),
    ]);
    expect((await client.secrets.list()).keys.toSorted()).toEqual(["EXTRA_TOKEN", "HOST_SSH_KEY", "OPENAI_KEY", "SENTRY_DSN", "STRIPE_KEY"]);
});

// The same race across verbs, and the one that matters most: a `set` overlapping a `remove` must not restore the removed
// key from a stale snapshot, leaving a credential the owner was told had been revoked.
test("a secrets.set overlapping a secrets.remove does not resurrect the removed key", async () => {
    const client = clientFor(createApp(await seeded()));
    await Promise.all([client.secrets.set({ key: "NEW_TOKEN", value: "added" }), client.secrets.remove({ key: "EXTRA_TOKEN" })]);
    expect((await client.secrets.list()).keys.toSorted()).toEqual(["HOST_SSH_KEY", "NEW_TOKEN"]);
});

// A gate names exactly who may release a credential, and the owner writes it alone because a maintainer is who it may
// be written about. Revealing the value is releasing it to a person, so the gate holds there too: the operating tier
// reads every ungated value, and a gated one only when it is among the approvers.
test("secrets.reveal holds a gated credential to its approvers, and inventory says who may", async () => {
    const as = (email: string, role: "owner" | "maintainer") => {
        const svc = services({ auth: { authorize: async () => proven(email, role), authorizeOwner: rejectForbidden } });
        return { svc, client: clientFor(createApp(svc), { bearer: email }) };
    };
    const seed = async (svc: ReturnType<typeof services>): Promise<void> => {
        await svc.sandboxSecrets.set("STRIPE_KEY", "sk_live_gated");
        await svc.sandboxSecrets.set("SENTRY_DSN", "https://ungated");
        await svc.credentialGates.set({ kind: "secret", subject: "STRIPE_KEY", approvers: ["ada@example.com"], scope: "use" });
    };
    const revealable = async (client: ReturnType<typeof clientFor>): Promise<Record<string, boolean>> =>
        Object.fromEntries((await client.secrets.inventory()).entries.filter((entry) => entry.kind === "env").map((entry) => [entry.key, entry.revealable]));

    const maintainer = as("max@example.com", "maintainer");
    await seed(maintainer.svc);
    expect(await errorCode(maintainer.client.secrets.reveal({ key: "STRIPE_KEY" }))).toBe("FORBIDDEN");
    expect(await maintainer.client.secrets.reveal({ key: "SENTRY_DSN" })).toEqual({ value: "https://ungated" });
    expect(await revealable(maintainer.client)).toEqual({ STRIPE_KEY: false, SENTRY_DSN: true });

    const approver = as("ADA@example.com", "owner");
    await seed(approver.svc);
    expect(await approver.client.secrets.reveal({ key: "STRIPE_KEY" })).toEqual({ value: "sk_live_gated" });
    expect(await revealable(approver.client)).toEqual({ STRIPE_KEY: true, SENTRY_DSN: true });
});

