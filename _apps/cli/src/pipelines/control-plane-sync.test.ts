import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DesiredStateGraph, SecretSource } from "@intentic/graph";
import { fakeForgejoApi } from "@intentic/providers";
import { expect, test } from "vitest";
import { APPLY_WORKFLOW_PATH } from "./adopt-pipelines.js";
import { syncControlPlaneSecrets } from "./control-plane-sync.js";

// A minimal artifact whose forgejo node carries the admin identity, plus one $secret input per listed key so
// `collectSecrets` discovers them. FORGEJO_ADMIN_PASSWORD is always present (the node's adminPassword).
const secretInput = (source: SecretSource, key: string) => ({ $secret: { source, key } });

const graph = (secrets: { readonly generated?: readonly string[]; readonly env?: readonly string[] }): DesiredStateGraph => {
    return {
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
                    ...Object.fromEntries((secrets.generated ?? []).map((key, i) => [`g${i}`, secretInput("generated", key)])),
                    ...Object.fromEntries((secrets.env ?? []).map((key, i) => [`e${i}`, secretInput("env", key)])),
                },
            },
        },
    };
};

const recordingApi = () => {
    const calls: { name: string; secretName: string; data: string }[] = [];
    const api = fakeForgejoApi({
        setRepoSecret: async ({ name, secretName, data }) => {
            calls.push({ name, secretName, data });
        },
    });
    return { api, calls };
};

const tempDir = () => mkdtemp(join(tmpdir(), "intentic-sync-"));

test("a newly-required generated secret is pushed to Forgejo; existing ones are untouched", async () => {
    const { api, calls } = recordingApi();
    const dir = await tempDir();
    try {
        const result = await syncControlPlaneSecrets({
            previousGraph: graph({}),
            newGraph: graph({ generated: ["APP_DATABASE_PASSWORD"] }),
            env: { APP_DATABASE_PASSWORD: "db-secret", GIT_TOKEN: "pw" },
            dir,
            password: "pw",
            cliVersion: "1.2.3",
            log: () => {},
            api,
        });

        // Only the new key is pushed — never FORGEJO_ADMIN_PASSWORD, which already exists in Forgejo.
        expect(calls).toEqual([{ name: "desired-state", secretName: "APP_DATABASE_PASSWORD", data: "db-secret" }]);
        expect(result.pushed).toEqual(["APP_DATABASE_PASSWORD"]);
        const apply = await readFile(join(dir, APPLY_WORKFLOW_PATH), "utf8");
        expect(apply).toContain(`APP_DATABASE_PASSWORD: \${{ secrets.APP_DATABASE_PASSWORD }}`);
        expect(apply).toContain(`FORGEJO_ADMIN_PASSWORD: \${{ secrets.INTENTIC_FORGEJO_ADMIN_PASSWORD }}`);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("a newly-required env secret is not pushed but is reported and added to apply.yaml", async () => {
    const { api, calls } = recordingApi();
    const dir = await tempDir();
    try {
        const result = await syncControlPlaneSecrets({
            previousGraph: graph({}),
            newGraph: graph({ env: ["STRIPE_KEY"] }),
            env: { GIT_TOKEN: "pw" },
            dir,
            password: "pw",
            cliVersion: "1.2.3",
            log: () => {},
            api,
        });

        expect(calls).toEqual([]);
        expect(result.pushed).toEqual([]);
        expect(result.newEnv).toEqual(["STRIPE_KEY"]);
        const apply = await readFile(join(dir, APPLY_WORKFLOW_PATH), "utf8");
        expect(apply).toContain(`STRIPE_KEY: \${{ secrets.STRIPE_KEY }}`);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("without a previous artifact nothing is pushed and apply.yaml is not regenerated (overwrite guard)", async () => {
    const { api, calls } = recordingApi();
    const dir = await tempDir();
    try {
        const result = await syncControlPlaneSecrets({
            previousGraph: undefined,
            newGraph: graph({ generated: ["APP_DATABASE_PASSWORD"] }),
            env: { APP_DATABASE_PASSWORD: "db-secret", GIT_TOKEN: "pw" },
            dir,
            password: "pw",
            cliVersion: "1.2.3",
            log: () => {},
            api,
        });

        expect(calls).toEqual([]);
        expect(result).toEqual({ pushed: [], newEnv: [] });
        expect(existsSync(join(dir, APPLY_WORKFLOW_PATH))).toBe(false);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});
