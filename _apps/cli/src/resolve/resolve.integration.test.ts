import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { IntentSet } from "@intentic/need-resolver";
import { resolveState } from "@intentic/state-resolver";
import { describe, expect, it } from "vitest";
import { collectSecrets } from "../secrets/secrets.js";
import { discoverZone, loadIntent } from "./resolve.js";

const example = fileURLToPath(new URL("../__fixtures__/deploy.config.ts", import.meta.url));

describe("loadIntent", () => {
    it("loads an intent that resolves to a compiled graph", async () => {
        const intent = await loadIntent(example);
        expect(intent.apps.length).toBeGreaterThan(0);
        const graph = resolveState(intent, "example.com");
        expect(graph.version).toBe(1);
        expect(Object.keys(graph.resources).length).toBeGreaterThan(0);
    });

    it("classifies secrets: externals are user-supplied, platform admin secrets are intentic-generated", async () => {
        const graph = resolveState(await loadIntent(example), "example.com");
        // FORGEJO_ADMIN_PASSWORD / KOMODO_ADMIN_PASSWORD / RESTIC_PASSWORD are injected by the resolver (the
        // platform layer + the on-by-default backup) and marked generated; the externals stay env (intentic
        // can't invent them).
        expect(collectSecrets(graph)).toEqual({
            env: ["CLOUDFLARE_API_TOKEN", "HOST_SSH_KEY", "PRODUCTION_DATABASE_URL", "STAGING_DATABASE_URL"],
            generated: ["FORGEJO_ADMIN_PASSWORD", "KOMODO_ADMIN_PASSWORD", "RESTIC_PASSWORD"],
        });
    });

    it("throws when the config does not export intent", async () => {
        const notAConfig = fileURLToPath(new URL("../lib/artifact.ts", import.meta.url));
        await expect(loadIntent(notAConfig)).rejects.toThrow(/must export "intent"/);
    });
});

const intentWith = (zone: string | undefined, domain: string): IntentSet =>
    ({
        cloudflare: { id: "cf", input: { apiToken: { source: "env", key: "CLOUDFLARE_API_TOKEN" }, ...(zone !== undefined ? { zone } : {}) } },
        apps: [],
        services: [{ id: "svc", kind: "outline", on: "self", expose: "cf", domain }],
    }) as unknown as IntentSet;

describe("discoverZone", () => {
    it("uses the authored zone without needing the API token", async () => {
        const dir = await mkdtemp(join(tmpdir(), "intentic-zone-"));
        delete process.env["CLOUDFLARE_API_TOKEN"];
        await expect(discoverZone(intentWith("example.com", "outline.example.com"), dir)).resolves.toBe("example.com");
    });

    it("rejects a domain outside the authored zone", async () => {
        const dir = await mkdtemp(join(tmpdir(), "intentic-zone-"));
        await expect(discoverZone(intentWith("example.com", "outline.other.net"), dir)).rejects.toThrow(/not under any zone/);
    });

    it("still requires the token when no zone is authored", async () => {
        const dir = await mkdtemp(join(tmpdir(), "intentic-zone-"));
        delete process.env["CLOUDFLARE_API_TOKEN"];
        await expect(discoverZone(intentWith(undefined, "outline.example.com"), dir)).rejects.toThrow(/set CLOUDFLARE_API_TOKEN/);
    });
});
