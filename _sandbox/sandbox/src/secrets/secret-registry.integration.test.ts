import { mkdtempSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ENV_FILE, SECRETS_FILE } from "@intentic/scaffold";
import { capabilitySecretsDocument, fileSecretVault } from "../capabilities/credentials/secret-vault.js";
import { hasSecretReferences, resolveSecretReferences, secretReference, secretRegistryOf } from "./secret-registry.js";
import { fileSandboxSecrets } from "./sandbox-secrets.js";
import { maskTargets } from "../agent/tools/agent-redaction.js";

// Secrets live in four stores (SECRET_STORES: DevOps .env, the sandbox's own, deploy-generated values, capability
// vault); pins that the registry unions them, each value keeps its reference name, and a store that fails fails the
// read: its values could not be masked.

const withStores = () => {
    const root = mkdtempSync(join(tmpdir(), "secret-registry-"));
    const repo = join(root, "desired-state");
    const vault = fileSecretVault(capabilitySecretsDocument, join(root, "auth", "capability-secrets.json"));
    const write = async (file: string, body: string): Promise<void> => {
        await mkdir(repo, { recursive: true });
        await writeFile(join(repo, file), body);
    };
    const sandbox = fileSandboxSecrets(join(root, "auth", "sandbox-secrets.json"));
    return { vault, write, sandbox, registry: secretRegistryOf(vault, () => repo, sandbox) };
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
    const { vault, registry } = withStores();
    await vault.set("vpnbox", { presharedKey: "K7mNp2qR8tVw3xYz5aBc", config: "conf-body-aaaa" });
    expect((await registry()).map((secret) => secret.name).toSorted()).toEqual(["vpnbox/config", "vpnbox/presharedKey"]);
});

test("an unreadable vault fails the whole read rather than answering without its values", async () => {
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
        { all: async () => ({}) },
    );
    await expect(broken()).rejects.toThrow("EACCES");
});

test("nothing stored anywhere is an empty registry, not a throw", async () => {
    const { registry } = withStores();
    expect(await registry()).toEqual([]);
});

test("a credential connected mid-turn is in the very next read", async () => {
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
    expect(resolved.text).toContain(secretReference("NOPE"));
    expect(resolved.used).toEqual(["CLOUDFLARE_API_TOKEN"]);
    expect(resolved.unknown).toEqual(["NOPE"]);
});

test("a generated value that is not a string is left out rather than failing the read", async () => {
    const { write, registry } = withStores();
    await write(SECRETS_FILE, JSON.stringify({ GRAFANA_ADMIN_PASSWORD: "gen-a8f2k1m4p7q9", REPLICAS: 3 }));
    expect((await registry()).map((secret) => secret.name)).toEqual(["GRAFANA_ADMIN_PASSWORD"]);
});

test("the reference pre-check answers the same however often it is asked", () => {
    const command = `curl -H "x: ${secretReference("CLOUDFLARE_API_TOKEN")}"`;
    expect([hasSecretReferences(command), hasSecretReferences(command), hasSecretReferences("echo plain")]).toEqual([true, true, false]);
});

test("a secret kept without DevOps resolves by its plain name, and the desired-state .env wins a name both hold", async () => {
    const { sandbox, write, registry } = withStores();
    await sandbox.set("OPENAI_API_KEY", "sk-sandbox-kept-value-01");
    await sandbox.set("SHARED_NAME", "from-the-sandbox-store");
    await write(ENV_FILE, "SHARED_NAME=from-the-env-file\n");
    const byName = new Map((await registry()).map((secret) => [secret.name, secret]));
    expect(byName.get("OPENAI_API_KEY")).toEqual({ name: "OPENAI_API_KEY", value: "sk-sandbox-kept-value-01", source: "sandbox" });
    expect(byName.get("SHARED_NAME")).toEqual({ name: "SHARED_NAME", value: "from-the-env-file", source: "env" });
});

test("a keyring's copies are listed like a stored secret, and a value a keyring released is listed under its own source, to mask", async () => {
    const root = mkdtempSync(join(tmpdir(), "secret-registry-"));
    const vault = fileSecretVault(capabilitySecretsDocument, join(root, "auth", "capability-secrets.json"));
    const sandbox = fileSandboxSecrets(join(root, "auth", "sandbox-secrets.json"));
    const released = new Map([["VPN_PASSWORD", "released-vpn-value-123"]]);
    const registry = secretRegistryOf(vault, () => join(root, "desired-state"), sandbox, {
        copies: async () => ({ DB_PASSWORD: "copied-db-value-456" }),
        released: () => Object.fromEntries(released),
    });
    expect(await registry()).toEqual([
        { name: "DB_PASSWORD", value: "copied-db-value-456", source: "copy" },
        { name: "VPN_PASSWORD", value: "released-vpn-value-123", source: "device" },
    ]);
    // What the agent reads of a command that printed it: the reference, as for any stored value.
    const masked = maskTargets(await registry()).reduce((text, { target, replacement }) => text.split(target).join(replacement), "got released-vpn-value-123 back");
    expect(masked).toBe(`got ${secretReference("VPN_PASSWORD")} back`);
    // A sandbox secret of the same name wins, and the released value is no longer listed under it.
    await sandbox.set("VPN_PASSWORD", "sandbox-held-vpn-789");
    expect((await registry()).filter((secret) => secret.name === "VPN_PASSWORD")).toEqual([{ name: "VPN_PASSWORD", value: "sandbox-held-vpn-789", source: "sandbox" }]);
});
