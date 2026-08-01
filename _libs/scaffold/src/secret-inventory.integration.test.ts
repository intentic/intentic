import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { collectSecretInventory, readSyncState, secretDigest, SYNC_FILE, writeSyncState } from "./secret-inventory.js";

const env = (key: string) => ({ $secret: { source: "env", key } });
const gen = (key: string) => ({ $secret: { source: "generated", key } });

const artifact = {
    version: 1,
    resources: {
        host: { id: "host", type: "host", inputs: { sshKey: env("HOST_SSH_KEY") }, dependsOn: [] },
        forgejo: { id: "forgejo", type: "forgejo", inputs: { adminPassword: gen("FORGEJO_ADMIN_PASSWORD") }, dependsOn: [] },
    },
};

const dir = async (files: Record<string, string>): Promise<string> => {
    const root = await mkdtemp(join(tmpdir(), "intentic-inventory-"));
    for (const [name, content] of Object.entries(files)) {
        await writeFile(join(root, name), content);
    }
    return root;
};

describe("collectSecretInventory", () => {
    it("merges artifact requirements with .env / .secrets.json presence and undeclared keys", async () => {
        const root = await dir({
            "desired-state.json": JSON.stringify(artifact),
            ".env": 'HOST_SSH_KEY="key-material"\nEXTRA_TOKEN="abc"\n',
            ".secrets.json": JSON.stringify({ FORGEJO_ADMIN_PASSWORD: "pw" }),
        });
        expect(await collectSecretInventory(root)).toEqual([
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
        ]);
    });

    it("marks unset declared keys missing and works without an artifact", async () => {
        const withArtifact = await dir({ "desired-state.json": JSON.stringify(artifact) });
        const entries = await collectSecretInventory(withArtifact);
        expect(entries.map((e) => [e.key, e.status])).toEqual([
            ["FORGEJO_ADMIN_PASSWORD", "missing"],
            ["HOST_SSH_KEY", "missing"],
        ]);

        const bare = await dir({ ".env": 'ONLY_KEY="v"\n' });
        expect((await collectSecretInventory(bare)).map((e) => e.key)).toEqual(["ONLY_KEY"]);
    });

    it("reports CI sync state from the pushed-digest record once adopted", async () => {
        const root = await dir({
            "desired-state.json": JSON.stringify(artifact),
            ".env": 'HOST_SSH_KEY="rotated"\nEXTRA_TOKEN="abc"\n',
            ".secrets.json": JSON.stringify({ FORGEJO_ADMIN_PASSWORD: "pw" }),
        });
        await writeSyncState(root, {
            HOST_SSH_KEY: { digest: secretDigest("original"), pushedAt: "2026-01-01T00:00:00.000Z" },
            FORGEJO_ADMIN_PASSWORD: { digest: secretDigest("pw"), pushedAt: "2026-01-01T00:00:00.000Z" },
        });
        const byKey = new Map((await collectSecretInventory(root)).map((e) => [e.key, e.ci]));
        expect(byKey.get("HOST_SSH_KEY")).toEqual({ synced: false, pushedAt: "2026-01-01T00:00:00.000Z" });
        expect(byKey.get("FORGEJO_ADMIN_PASSWORD")).toEqual({ synced: true, pushedAt: "2026-01-01T00:00:00.000Z" });
        // Never pushed at all → stale, with no pushedAt.
        expect(byKey.get("EXTRA_TOKEN")).toEqual({ synced: false });
    });
});

describe("sync state round-trip", () => {
    it("reads back what it wrote and defaults to empty", async () => {
        const root = await dir({});
        expect(await readSyncState(root)).toEqual({});
        const state = { K: { digest: secretDigest("v"), pushedAt: "2026-01-01T00:00:00.000Z" } };
        await writeSyncState(root, state);
        expect(await readSyncState(root)).toEqual(state);
        expect(SYNC_FILE).toBe(".secrets-sync.json");
    });
});
