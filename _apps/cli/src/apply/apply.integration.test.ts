import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createFakeProviders, reconcile } from "@intentic/engine";
import { resolveState } from "@intentic/state-resolver";
import { describe, expect, it } from "vitest";
import { readArtifact, writeArtifact } from "../lib/artifact.js";
import { loadIntent } from "../resolve/resolve.js";
import { collectAccess, formatAccessSummary, writeAccessFile } from "./access.js";

const example = fileURLToPath(new URL("../__fixtures__/deploy.config.ts", import.meta.url));

// Every secret the example references: the host SSH key and Cloudflare API token plus the app secrets.
// The host address/user are authored literals and the Cloudflare zone/account are discovered, not here.
const fullEnv = {
    HOST_SSH_KEY: "k",
    CLOUDFLARE_API_TOKEN: "k",
    FORGEJO_ADMIN_PASSWORD: "k",
    KOMODO_ADMIN_PASSWORD: "k",
    RESTIC_PASSWORD: "k",
    STAGING_DATABASE_URL: "k",
    PRODUCTION_DATABASE_URL: "k",
};

describe("the local resolve → write → read → apply pipeline", () => {
    it("resolves to an artifact that reconciles to convergence with fake providers", async () => {
        const graph = resolveState(await loadIntent(example), "example.com");
        const dir = await mkdtemp(join(tmpdir(), "intentic-cli-"));
        const path = join(dir, "desired-state.json");
        await writeArtifact(path, graph);

        const roundTripped = await readArtifact(path);
        const { providers } = createFakeProviders();
        const result = await reconcile(roundTripped, { providers, env: fullEnv, probe: async () => true, log: () => {} }, { maxIterations: 5 });

        expect(result.converged).toBe(true);
        expect(Object.keys(result.outcome.outputs).toSorted()).toEqual(Object.keys(roundTripped.resources).toSorted());
    });

    it("derives access info from the real resolved graph and writes a secret-free access.md", async () => {
        const graph = resolveState(await loadIntent(example), "example.com");
        const { providers } = createFakeProviders();
        // A distinctive password value so the no-leak assertion below is meaningful (vs the "k" stubs).
        const sentinel = "S3NTINEL_DO_NOT_LEAK";
        const env = { ...fullEnv, FORGEJO_ADMIN_PASSWORD: sentinel };
        const result = await reconcile(graph, { providers, env, probe: async () => true, log: () => {} }, { maxIterations: 5 });

        const access = collectAccess(graph, result.outcome.outputs, env);
        // The field names access.ts reads (adminUser/adminPassword, url) must match what the resolver emits,
        // and the platform passwords must come through as generated secrets.
        expect(access).toContainEqual(
            expect.objectContaining({
                label: "Forgejo (git)",
                username: "intentic",
                password: { source: "generated", key: "FORGEJO_ADMIN_PASSWORD", value: sentinel },
            }),
        );
        expect(access).toContainEqual(
            expect.objectContaining({
                label: "Komodo (deploys)",
                username: "intentic",
                password: expect.objectContaining({ source: "generated", key: "KOMODO_ADMIN_PASSWORD" }),
            }),
        );
        // App environments are surfaced URL-only (no login).
        expect(access).toContainEqual(expect.objectContaining({ id: "my-app.production", url: expect.any(String) }));

        // stdout reveals the generated value (so the user can log in); the committed file never does.
        expect(formatAccessSummary(access)).toContain(`password: ${sentinel}  (saved in .secrets.json)`);

        const dir = await mkdtemp(join(tmpdir(), "intentic-access-"));
        const path = join(dir, "access.md");
        await writeAccessFile(path, access);
        const markdown = await readFile(path, "utf8");
        expect(markdown).toContain("generated (see `.secrets.json`)");
        expect(markdown).not.toContain("$secret");
        expect(markdown).not.toContain(sentinel);
    });
});
