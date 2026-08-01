import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workspacePaths } from "../workspace/workspace.js";
import type { Capability } from "@intentic/sandbox-contract";

import { expect, test, vi } from "vitest";

import { createApp } from "../app.js";

import { clientFor, errorCode, memoryCapabilitiesStore, rejectForbidden, services } from "../route-testing.js";

/* The secrets routes, driven over the daemon's HTTP surface exactly as the browser drives them.
 * Split out of app.integration.test.ts, which had grown to 116 tests across every route in the daemon —
 * one file that two agents working on unrelated features collided in every time. The fakes and the client
 * are shared (route-testing.ts); what lives here is what these routes do. */

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
        { key: "github", kind: "capability", status: "connected", requiredBy: [], storedAt: ".intentic/capabilities.json", revealable: true },
        {
            key: "claude:default",
            kind: "provider",
            label: "Claude · Claude",
            status: "connected",
            requiredBy: [],
            storedAt: ".intentic/claude/default.json",
            revealable: false,
        },
    ]);
});

test("secrets.inventory answers pre-scaffold with capability/provider entries only", async () => {
    const client = clientFor(createApp(services()));
    const { entries } = await client.secrets.inventory();
    // One entry per connected account: the default fake has a single Claude account, no Codex, no Grok.
    expect(entries.map((entry) => entry.key)).toEqual(["claude:default"]);
});

test("secrets.reveal returns env and generated values, 404s unknown keys, and is owner-gated", async () => {
    const workspace = secretsWorkspace();
    const client = clientFor(createApp(services({ workspace })));
    expect(await client.secrets.reveal({ key: "HOST_SSH_KEY" })).toEqual({ value: "pem" });
    expect(await client.secrets.reveal({ key: "FORGEJO_ADMIN_PASSWORD" })).toEqual({ value: "pw1" });
    expect(await errorCode(client.secrets.reveal({ key: "GHOST" }))).toBe("NOT_FOUND");

    // A verified member who is not the owner is refused the value (the rest of the secrets surface stays open).
    const memberClient = clientFor(
        createApp(services({ workspace, auth: { authorize: async () => ({ email: "m@example.com" }), authorizeOwner: rejectForbidden } })),
    );
    expect(await errorCode(memberClient.secrets.reveal({ key: "HOST_SSH_KEY" }))).toBe("FORBIDDEN");
});

test("secrets.set / remove rewrite .env and fire a best-effort `secrets push` for the CI copy", async () => {
    const pushes: string[][] = [];
    const client = clientFor(
        createApp(
            services({
                workspace: secretsWorkspace(),
                intentic: async function* (run) {
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
    await vi.waitFor(() =>
        expect(pushes).toEqual([
            ["deploy", "secrets", "push"],
            ["deploy", "secrets", "push"],
        ]),
    );
});
