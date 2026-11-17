import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capabilitySecretsDocument, fileSecretVault } from "../capabilities/credentials/secret-vault.js";
import { hasSecretReferences, resolveSecretReferences, secretReference, secretRegistryOf, type KeptFromKeyrings } from "./secret-registry.js";
import { fileSandboxSecrets } from "./sandbox-secrets.js";
import { maskTargets } from "../agent/tools/agent-redaction.js";

// Secrets live in the stores SECRET_STORES lists (the sandbox's own, the capability vault, a keyring's copies and the
// values a keyring released); pins that the registry unions them, each value keeps its reference name, and a store that
// fails fails the read: its values could not be masked.

const withStores = (keyrings?: KeptFromKeyrings) => {
    const root = mkdtempSync(join(tmpdir(), "secret-registry-"));
    const vault = fileSecretVault(capabilitySecretsDocument, join(root, "auth", "capability-secrets.json"));
    const sandbox = fileSandboxSecrets(join(root, "auth", "sandbox-secrets.json"));
    return { vault, sandbox, registry: secretRegistryOf(vault, sandbox, keyrings) };
};

test("names are a value-free projection of the last successful registry read", async () => {
    let failing = false;
    const { sandbox, registry } = withStores({
        copies: async () => {
            if (failing) {
                throw new Error("EACCES");
            }
            return {};
        },
        released: () => ({}),
    });
    expect(registry.names?.()).toBeUndefined();
    await sandbox.set("API_TOKEN", "synthetic-fixture");
    await registry();
    expect(registry.names?.()).toEqual(["API_TOKEN"]);
    const refreshing = registry();
    expect(registry.names?.()).toEqual(["API_TOKEN"]);
    await refreshing;
    failing = true;
    await expect(registry()).rejects.toThrow();
    expect(registry.names?.()).toBeUndefined();
});

test("the names projection excludes device releases but retains sandbox-held and copied names", async () => {
    const { registry, sandbox } = withStores({
        copies: async () => ({ COPIED_TOKEN: "synthetic-copy" }),
        released: () => ({ DEVICE_TOKEN: "synthetic-release" }),
    });
    await sandbox.set("API_TOKEN", "synthetic-local");
    expect((await registry()).map(({ name }) => name)).toEqual(["API_TOKEN", "COPIED_TOKEN", "DEVICE_TOKEN"]);
    expect(registry.names?.()).toEqual(["API_TOKEN", "COPIED_TOKEN"]);
    // A local value of the same name takes precedence and should use sandbox guard metadata.
    await sandbox.set("DEVICE_TOKEN", "synthetic-local-override");
    await registry();
    expect(registry.names?.()).toContain("DEVICE_TOKEN");
});

test("the registry is the union of the stores, each value under its name", async () => {
    const { vault, sandbox, registry } = withStores();
    await vault.set("reddit", { password: "Xk4!mQ2pRt7@wZ9aBc1_" });
    await sandbox.set("CLOUDFLARE_API_TOKEN", "cf_live_0011223344ff");
    expect((await registry()).toSorted((a, b) => a.name.localeCompare(b.name))).toEqual([
        { name: "CLOUDFLARE_API_TOKEN", value: "cf_live_0011223344ff", source: "sandbox" },
        { name: "reddit/password", value: "Xk4!mQ2pRt7@wZ9aBc1_", source: "capability" },
    ]);
});

test("a vault capability holding several fields names each one", async () => {
    const { vault, registry } = withStores();
    await vault.set("vpnbox", { presharedKey: "K7mNp2qR8tVw3xYz5aBc", config: "conf-body-aaaa" });
    expect((await registry()).map((secret) => secret.name).toSorted()).toEqual(["vpnbox/config", "vpnbox/presharedKey"]);
});

test("an unreadable vault fails the whole read rather than answering without its values", async () => {
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
        { all: async () => ({ CLOUDFLARE_API_TOKEN: "cf_live_0011223344ff" }) },
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
        { name: "CLOUDFLARE_API_TOKEN", value: "cf_live_0011223344ff", source: "sandbox" as const },
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

test("the reference pre-check answers the same however often it is asked", () => {
    const command = `curl -H "x: ${secretReference("CLOUDFLARE_API_TOKEN")}"`;
    expect([hasSecretReferences(command), hasSecretReferences(command), hasSecretReferences("echo plain")]).toEqual([true, true, false]);
});

test("a secret a person kept resolves by its plain name, and wins a name a keyring's copy also holds", async () => {
    const { sandbox, registry } = withStores({ copies: async () => ({ SHARED_NAME: "from-a-keyring-copy" }), released: () => ({}) });
    await sandbox.set("OPENAI_API_KEY", "sk-sandbox-kept-value-01");
    await sandbox.set("SHARED_NAME", "from-the-sandbox-store");
    const byName = new Map((await registry()).map((secret) => [secret.name, secret]));
    expect(byName.get("OPENAI_API_KEY")).toEqual({ name: "OPENAI_API_KEY", value: "sk-sandbox-kept-value-01", source: "sandbox" });
    expect(byName.get("SHARED_NAME")).toEqual({ name: "SHARED_NAME", value: "from-the-sandbox-store", source: "sandbox" });
});

test("a keyring's copies are listed like a stored secret, and a value a keyring released is listed under its own source, to mask", async () => {
    const root = mkdtempSync(join(tmpdir(), "secret-registry-"));
    const vault = fileSecretVault(capabilitySecretsDocument, join(root, "auth", "capability-secrets.json"));
    const sandbox = fileSandboxSecrets(join(root, "auth", "sandbox-secrets.json"));
    const released = new Map([["VPN_PASSWORD", "released-vpn-value-123"]]);
    const registry = secretRegistryOf(vault, sandbox, {
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
