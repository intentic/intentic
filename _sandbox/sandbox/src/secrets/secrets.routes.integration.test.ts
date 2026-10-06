import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STATE_DIR } from "@intentic/constants";
import { workspacePaths } from "../workspace/workspace.js";
import type { Capability } from "@intentic/sandbox-contract";

import { SETTLES, waitFor } from "@intentic/testing/bun";

import { createApp } from "../app.js";

import { clientFor, errorCode, proven, rejectForbidden } from "../harness/route-client.testing.js";
import { services } from "../harness/route-services.testing.js";
import { memoryCapabilitiesStore } from "../capabilities/capabilities-slice.testing.js";

// Drives the secrets routes over the daemon's HTTP surface the way the browser does; fakes and the client are shared
// from route-services.testing.ts and its siblings.

// A scaffolded desired-state checkout on disk: an artifact requiring HOST_SSH_KEY, an .env holding it plus an
// undeclared EXTRA_TOKEN, and a generated admin password in .secrets.json.
const secretsWorkspace = (): ReturnType<typeof workspacePaths> => {
    const root = mkdtempSync(join(tmpdir(), "sandbox-secrets-"));
    const workspace = workspacePaths(root);
    mkdirSync(workspace.repos["desired-state"], { recursive: true });
    const artifact = {
        version: 1,
        resources: {
            host: { id: "host", type: "host", inputs: { sshKey: { $secret: { source: "env", key: "HOST_SSH_KEY" } } }, dependsOn: [] },
            forgejo: {
                id: "forgejo",
                type: "forgejo",
                inputs: { adminPassword: { $secret: { source: "generated", key: "FORGEJO_ADMIN_PASSWORD" } } },
                dependsOn: [],
            },
        },
    };
    writeFileSync(join(workspace.repos["desired-state"], "desired-state.json"), JSON.stringify(artifact));
    writeFileSync(join(workspace.repos["desired-state"], ".env"), 'HOST_SSH_KEY="pem"\nEXTRA_TOKEN="abc"\n');
    writeFileSync(join(workspace.repos["desired-state"], ".secrets.json"), JSON.stringify({ FORGEJO_ADMIN_PASSWORD: "pw1" }));
    return workspace;
};

test("without DevOps, set / list / reveal / remove use the sandbox's own store (the desired-state repo is absent under test)", async () => {
    // Keeping a key for the agent never waits on a deploy pipeline being scaffolded first.
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

test("secrets.inventory merges artifact requirements, .env keys, credentialed capabilities, and provider accounts", async () => {
    const github: Capability = { id: "github", kind: "cli", config: { provider: "github", token: "gh-token" } };
    const client = clientFor(createApp(services({ workspace: secretsWorkspace(), capabilities: memoryCapabilitiesStore([github]) })));
    const { entries } = await client.secrets.inventory();
    expect(entries).toEqual([
        {
            key: "FORGEJO_ADMIN_PASSWORD",
            kind: "generated",
            status: "set",
            requiredBy: [{ resourceId: "forgejo", type: "forgejo" }],
            storedAt: "desired-state/.secrets.json",
            revealable: true,
        },
        {
            key: "HOST_SSH_KEY",
            kind: "env",
            status: "set",
            requiredBy: [{ resourceId: "host", type: "host" }],
            storedAt: "desired-state/.env",
            revealable: true,
        },
        { key: "EXTRA_TOKEN", kind: "env", status: "set", requiredBy: [], storedAt: "desired-state/.env", revealable: true },
        {
            key: "github",
            kind: "capability",
            status: "connected",
            requiredBy: [],
            storedAt: `${STATE_DIR}/secrets/auth/capability-secrets.json`,
            revealable: true,
        },
        {
            key: "claude:default",
            kind: "provider",
            label: "Claude · Claude",
            status: "connected",
            requiredBy: [],
            storedAt: `${STATE_DIR}/secrets/auth/claude/default.json`,
            revealable: false,
        },
    ]);
});

test("secrets.inventory joins the use ledger: env keys by name, a capability by any of its fields", async () => {
    const github: Capability = { id: "github", kind: "cli", config: { provider: "github", token: "gh-token" } };
    const svc = services({ workspace: secretsWorkspace(), capabilities: memoryCapabilitiesStore([github]) });
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
    const svc = services({
        workspace: secretsWorkspace(),
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
    expect(byKey.get("FORGEJO_ADMIN_PASSWORD")?.hosts).toBeUndefined();
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

test("secrets.inventory answers pre-scaffold with capability/provider entries only", async () => {
    const client = clientFor(createApp(services()));
    const { entries } = await client.secrets.inventory();
    expect(entries.map((entry) => entry.key)).toEqual(["claude:default"]);
});

test("secrets.reveal returns values to the operating tier and refuses lower roles", async () => {
    const workspace = secretsWorkspace();
    const client = clientFor(createApp(services({ workspace })));
    expect(await client.secrets.reveal({ key: "HOST_SSH_KEY" })).toEqual({ value: "pem" });
    expect(await client.secrets.reveal({ key: "FORGEJO_ADMIN_PASSWORD" })).toEqual({ value: "pw1" });
    expect(await errorCode(client.secrets.reveal({ key: "GHOST" }))).toBe("NOT_FOUND");

    const maintainerClient = clientFor(
        createApp(
            services({
                workspace,
                auth: { authorize: async () => proven("m@example.com", "maintainer"), authorizeOwner: rejectForbidden },
            }),
        ),
    );
    expect(await maintainerClient.secrets.reveal({ key: "HOST_SSH_KEY" })).toEqual({ value: "pem" });

    const collaboratorClient = clientFor(
        createApp(
            services({
                workspace,
                auth: { authorize: async () => proven("c@example.com", "collaborator"), authorizeOwner: rejectForbidden },
            }),
        ),
    );
    expect(await errorCode(collaboratorClient.secrets.reveal({ key: "HOST_SSH_KEY" }))).toBe("FORBIDDEN");
});

test("secrets.set / remove rewrite .env and fire a best-effort `secrets push` for the CI copy", async () => {
    const pushes: string[][] = [];
    const client = clientFor(
        createApp(
            services({
                workspace: secretsWorkspace(),
                async *intentic(run) {
                    pushes.push([...run.args]);
                    yield { kind: `log`, message: `pushed` };
                },
            }),
        ),
    );
    await client.secrets.set({ key: "MyMixed_Key", value: "v1" });
    expect((await client.secrets.list()).keys.toSorted()).toEqual(["EXTRA_TOKEN", "HOST_SSH_KEY", "MyMixed_Key"]);
    await client.secrets.remove({ key: "EXTRA_TOKEN" });
    expect((await client.secrets.list()).keys.toSorted()).toEqual(["HOST_SSH_KEY", "MyMixed_Key"]);
    await waitFor(
        () =>
            expect(pushes).toEqual([
                ["deploy", "secrets", "push"],
                ["deploy", "secrets", "push"],
            ]),
        SETTLES,
    );
});

// The lost-update regression: `set` is read-modify-write, so before its writes were serialized two overlapping calls
// both read the pre-write file and the second erased the first one's key, while both answered ok.
test("concurrent secrets.set calls all land, none clobbering a write still in flight", async () => {
    const client = clientFor(createApp(services({ workspace: secretsWorkspace() })));
    await Promise.all([
        client.secrets.set({ key: "STRIPE_KEY", value: "sk_live_1" }),
        client.secrets.set({ key: "OPENAI_KEY", value: "sk-oai-2" }),
        client.secrets.set({ key: "SENTRY_DSN", value: "https://sentry" }),
    ]);
    expect((await client.secrets.list()).keys.toSorted()).toEqual(["EXTRA_TOKEN", "HOST_SSH_KEY", "OPENAI_KEY", "SENTRY_DSN", "STRIPE_KEY"]);
});

// The same race across verbs, and the one that matters most: a `set` overlapping a `remove` used to restore the removed
// key from its stale snapshot, leaving a credential the owner was told had been revoked.
test("a secrets.set overlapping a secrets.remove does not resurrect the removed key", async () => {
    const client = clientFor(createApp(services({ workspace: secretsWorkspace() })));
    await Promise.all([client.secrets.set({ key: "NEW_TOKEN", value: "added" }), client.secrets.remove({ key: "EXTRA_TOKEN" })]);
    expect((await client.secrets.list()).keys.toSorted()).toEqual(["HOST_SSH_KEY", "NEW_TOKEN"]);
});

// A .env value is wrapped in one of three quote characters, so a value holding all three cannot be written; the user
// gets a refusal naming what to change rather than a 500 about parsers.
test("secrets.set refuses a value holding all three quote characters, as a bad request", async () => {
    const client = clientFor(createApp(services({ workspace: secretsWorkspace() })));
    expect(await errorCode(client.secrets.set({ key: "PW", value: "p'a\"s`s" }))).toBe("BAD_REQUEST");
    // Refused before the write: the store is untouched, not half-rewritten.
    expect((await client.secrets.list()).keys.toSorted()).toEqual(["EXTRA_TOKEN", "HOST_SSH_KEY"]);
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

