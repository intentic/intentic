import { mkdtempSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ENV_FILE, SECRETS_FILE } from "@intentic/scaffold";
import { expect, test } from "vitest";
import { fileSecretVault } from "../capabilities/secret-vault.js";
import { resolveSecretReferences, secretReference, secretRegistryOf } from "./secret-registry.js";

/* WHAT THE MASKING AND THE EXITS ARE GIVEN. The product stores secrets in three places that all reach the
 * agent's environment — the capability vault, the DevOps `.env` and the deploy engine's generated values —
 * so a registry built from a subset would mask a connector's token and hand a deploy key straight to the
 * model. These pin that the registry is the union, that every value carries the name its reference uses, and
 * that no store failing takes the others' values down with it. */

const withStores = () => {
    const root = mkdtempSync(join(tmpdir(), "secret-registry-"));
    const repo = join(root, "desired-state");
    const vault = fileSecretVault(join(root, "auth", "capability-secrets.json"));
    const write = async (file: string, body: string): Promise<void> => {
        await mkdir(repo, { recursive: true });
        await writeFile(join(repo, file), body);
    };
    return { vault, write, registry: secretRegistryOf(vault, () => repo) };
};

test("the registry is the union of all three stores, each value under its name", async () => {
    const { vault, write, registry } = withStores();
    await vault.set("reddit", { password: "Xk4!mQ2pRt7@wZ9aBc1_" });
    await write(ENV_FILE, "CLOUDFLARE_API_TOKEN=cf_live_0011223344ff\n");
    await write(SECRETS_FILE, JSON.stringify({ GRAFANA_ADMIN_PASSWORD: "gen-a8f2k1m4p7q9" }));
    expect((await registry()).toSorted((a, b) => a.name.localeCompare(b.name))).toEqual([
        { name: "CLOUDFLARE_API_TOKEN", value: "cf_live_0011223344ff", source: "env" },
        { name: "GRAFANA_ADMIN_PASSWORD", value: "gen-a8f2k1m4p7q9", source: "generated" },
        { name: "reddit/password", value: "Xk4!mQ2pRt7@wZ9aBc1_", source: "capability" },
    ]);
});

test("a vault capability holding several fields names each one", async () => {
    // `<capability>/<field>`, because one capability may hold a presharedKey AND a config blob — a reference
    // must say which of them it stands for.
    const { vault, registry } = withStores();
    await vault.set("vpnbox", { presharedKey: "K7mNp2qR8tVw3xYz5aBc", config: "conf-body-aaaa" });
    expect((await registry()).map((secret) => secret.name).toSorted()).toEqual(["vpnbox/config", "vpnbox/presharedKey"]);
});

test("an unreadable vault still yields the repo stores' values", async () => {
    // No store may take the others down: masking only half the credentials is the failure this guards.
    const root = mkdtempSync(join(tmpdir(), "secret-registry-"));
    const repo = join(root, "desired-state");
    await mkdir(repo, { recursive: true });
    await writeFile(join(repo, ENV_FILE), "CLOUDFLARE_API_TOKEN=cf_live_0011223344ff\n");
    const broken = secretRegistryOf(
        {
            get: async () => ({}),
            all: async () => {
                throw new Error("EACCES");
            },
            set: async () => {},
            remove: async () => {},
            values: async () => [],
        },
        () => repo,
    );
    expect(await broken()).toEqual([{ name: "CLOUDFLARE_API_TOKEN", value: "cf_live_0011223344ff", source: "env" }]);
});

test("nothing stored anywhere is an empty registry, not a throw", async () => {
    const { registry } = withStores();
    expect(await registry()).toEqual([]);
});

test("a credential connected mid-turn is in the very next read", async () => {
    // Read on each call rather than cached — the window between connecting a service and the next tool result
    // is exactly where a cache would leak.
    const { vault, registry } = withStores();
    expect(await registry()).toEqual([]);
    await vault.set("reddit", { password: "Xk4!mQ2pRt7@wZ9aBc1_" });
    expect((await registry()).map((secret) => secret.name)).toEqual(["reddit/password"]);
});

test("resolution replaces known references, reports uses once, and names the unknown", () => {
    const secrets = [
        { name: "CLOUDFLARE_API_TOKEN", value: "cf_live_0011223344ff", source: "env" as const },
        { name: "reddit/password", value: "Xk4!mQ2pRt7@wZ9aBc1_", source: "capability" as const },
    ];
    const text = `curl -H "Authorization: Bearer ${secretReference("CLOUDFLARE_API_TOKEN")}" -d '{"again":"${secretReference(
        "CLOUDFLARE_API_TOKEN",
    )}","missing":"${secretReference("NOPE")}"}'`;
    const resolved = resolveSecretReferences(text, secrets);
    expect(resolved.text).toContain("Bearer cf_live_0011223344ff");
    expect(resolved.text).toContain('"again":"cf_live_0011223344ff"');
    // The unknown token survives as text — the CALLER refuses on `unknown`; silently dropping it would send a
    // config with a hole where a credential should be.
    expect(resolved.text).toContain(secretReference("NOPE"));
    expect(resolved.used).toEqual(["CLOUDFLARE_API_TOKEN"]);
    expect(resolved.unknown).toEqual(["NOPE"]);
});
