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
import { memoryCapabilitiesStore } from "../harness/route-stores.testing.js";

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

test("secrets.set / list / remove / reveal refuse until DevOps is active (the desired-state repo is absent under test)", async () => {
    const client = clientFor(createApp(services()));
    expect(await errorCode(client.secrets.set({ key: "CLOUDFLARE_API_TOKEN", value: "x" }))).toBe("PRECONDITION_FAILED");
    expect(await errorCode(client.secrets.list())).toBe("PRECONDITION_FAILED");
    expect(await errorCode(client.secrets.remove({ key: "CLOUDFLARE_API_TOKEN" }))).toBe("PRECONDITION_FAILED");
    expect(await errorCode(client.secrets.reveal({ key: "CLOUDFLARE_API_TOKEN" }))).toBe("PRECONDITION_FAILED");
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
