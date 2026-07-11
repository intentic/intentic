import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DesiredStateGraph, SecretSource } from "@intentic/graph";
import { fakeForgejoApi } from "@intentic/providers";
import { readSyncState, secretDigest, writeSyncState } from "@intentic/scaffold";
import { expect, test } from "vitest";
import type { Output } from "../lib/output.js";
import { APPLY_WORKFLOW_PATH } from "../pipelines/adopt-pipelines.js";
import { pushSecrets } from "./secrets.command.js";

const secretInput = (source: SecretSource, key: string) => ({ $secret: { source, key } });

const graph = (envKeys: readonly string[]): DesiredStateGraph => ({
    version: 1,
    resources: {
        "host-git": {
            id: "host-git",
            type: "forgejo",
            dependsOn: [],
            inputs: {
                domain: "git.example.com",
                adminUser: "intentic",
                adminPassword: secretInput("generated", "FORGEJO_ADMIN_PASSWORD"),
                ...Object.fromEntries(envKeys.map((key, i) => [`e${i}`, secretInput("env", key)])),
            },
        },
    },
});

const recordingApi = () => {
    const calls: { name: string; secretName: string; data: string }[] = [];
    const api = fakeForgejoApi({
        setRepoSecret: async ({ name, secretName, data }) => {
            calls.push({ name, secretName, data });
        },
    });
    return { api, calls };
};

const silentOut: Output = { mode: "text", onEvent: () => {}, log: () => {}, text: () => {}, result: () => {} };

const results = () => {
    const captured: Record<string, unknown>[] = [];
    const out: Output = { ...silentOut, result: (result) => captured.push(result) };
    return { out, captured };
};

// A desired-state checkout adopted earlier: artifact + .env + .secrets.json + the sync record `adopt` seeded.
const workspace = async (envKeys: readonly string[], env: Record<string, string>): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "intentic-push-"));
    await writeFile(join(dir, "desired-state.json"), JSON.stringify(graph(envKeys)));
    await writeFile(
        join(dir, ".env"),
        Object.entries(env)
            .map(([key, value]) => `${key}="${value}"\n`)
            .join(""),
    );
    await writeFile(join(dir, ".secrets.json"), JSON.stringify({ FORGEJO_ADMIN_PASSWORD: "admin-pw" }));
    return dir;
};

test("pushSecrets no-ops gracefully on a never-adopted workspace", async () => {
    const { api, calls } = recordingApi();
    const { out, captured } = results();
    const dir = await mkdtemp(join(tmpdir(), "intentic-push-"));
    try {
        await pushSecrets(out, join(dir, "desired-state.json"), api);
        expect(calls).toEqual([]);
        expect(captured).toEqual([{ pushed: [], reason: "not adopted" }]);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("pushSecrets pushes only changed values, mirrors the Cloudflare token to the intent repo, and records digests", async () => {
    const { api, calls } = recordingApi();
    const { out, captured } = results();
    // Unique env keys so loadEnvFile's process.env writes can't collide with other tests.
    const dir = await workspace(["PUSH_TEST_TOKEN", "CLOUDFLARE_API_TOKEN"], { PUSH_TEST_TOKEN: "rotated", CLOUDFLARE_API_TOKEN: "cf-new" });
    try {
        const pushedAt = "2026-01-01T00:00:00.000Z";
        await writeSyncState(dir, {
            PUSH_TEST_TOKEN: { digest: secretDigest("original"), pushedAt },
            CLOUDFLARE_API_TOKEN: { digest: secretDigest("cf-old"), pushedAt },
            FORGEJO_ADMIN_PASSWORD: { digest: secretDigest("admin-pw"), pushedAt },
        });
        await pushSecrets(out, join(dir, "desired-state.json"), api);

        expect(calls).toEqual([
            { name: "desired-state", secretName: "CLOUDFLARE_API_TOKEN", data: "cf-new" },
            { name: "desired-state", secretName: "PUSH_TEST_TOKEN", data: "rotated" },
            { name: "intent", secretName: "CLOUDFLARE_API_TOKEN", data: "cf-new" },
        ]);
        expect(captured).toEqual([{ pushed: ["CLOUDFLARE_API_TOKEN", "PUSH_TEST_TOKEN"], skipped: ["FORGEJO_ADMIN_PASSWORD"] }]);
        // No new key → apply.yaml untouched; digests now match, so a second push is a no-op.
        expect(existsSync(join(dir, APPLY_WORKFLOW_PATH))).toBe(false);
        expect((await readSyncState(dir))["PUSH_TEST_TOKEN"]?.digest).toBe(secretDigest("rotated"));

        const again = results();
        await pushSecrets(again.out, join(dir, "desired-state.json"), api);
        expect(calls).toHaveLength(3);
        expect(again.captured).toEqual([{ pushed: [], skipped: ["CLOUDFLARE_API_TOKEN", "FORGEJO_ADMIN_PASSWORD", "PUSH_TEST_TOKEN"] }]);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("pushSecrets regenerates apply.yaml when a new key joins the set", async () => {
    const { api } = recordingApi();
    const { out } = results();
    const dir = await workspace(["PUSH_TEST_NEW_KEY"], { PUSH_TEST_NEW_KEY: "value-1" });
    try {
        await writeSyncState(dir, { FORGEJO_ADMIN_PASSWORD: { digest: secretDigest("admin-pw"), pushedAt: "2026-01-01T00:00:00.000Z" } });
        await pushSecrets(out, join(dir, "desired-state.json"), api);
        const apply = await readFile(join(dir, APPLY_WORKFLOW_PATH), "utf8");
        expect(apply).toContain("PUSH_TEST_NEW_KEY: ${{ secrets.PUSH_TEST_NEW_KEY }}");
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});
