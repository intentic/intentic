import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STATE_DIR } from "@intentic/constants";
import type { Capability } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { type CapabilitiesStore, fileCapabilitiesStore, VAULTED, withSecretVault } from "./capabilities-store.js";
import { fileSecretVault } from "./secret-vault.js";

/* THE POINT OF THE SPLIT, pinned: the file the agent can open holds the shape of a connection and never the
 * credential in it, while every reader of the store still gets a whole Capability. Both halves matter — the
 * first is the exposure this closes, the second is why no call site had to change. */

const vaulted = (): { store: CapabilitiesStore; manifest: string; vaultPath: string } => {
    const root = mkdtempSync(join(tmpdir(), "vault-"));
    const manifest = join(root, STATE_DIR, "capabilities.json");
    const vaultPath = join(root, "auth", "capability-secrets.json");
    const inner = fileCapabilitiesStore(manifest);
    return { store: withSecretVault(inner, fileSecretVault(vaultPath), async () => new Map()), manifest, vaultPath };
};

const onDisk = async (path: string): Promise<string> => readFile(path, "utf8").catch(() => "");

const mcp = (id: string, token: string): Capability => ({ id, kind: "mcp", config: { url: "https://a/mcp", token } });
const browser = (id: string, password: string): Capability => ({ id, kind: "browser", config: { platform: "reddit", password } });

test("the manifest on disk carries a marker, never the credential", async () => {
    const { store, manifest, vaultPath } = vaulted();
    await store.upsert(mcp("linear", "mcp_tok_9f2b1c7e4a0d"));
    const written = await onDisk(manifest);
    expect(written).not.toContain("mcp_tok_9f2b1c7e4a0d");
    expect(written).toContain(VAULTED);
    // The non-secret half is untouched, which is what keeps the manifest worth reading and editing.
    expect(written).toContain("https://a/mcp");
    expect(await onDisk(vaultPath)).toContain("mcp_tok_9f2b1c7e4a0d");
});

test("a browser account's password — the credential the model is promised it never sees — leaves the manifest", async () => {
    const { store, manifest } = vaulted();
    await store.upsert(browser("reddit", "Xk4!mQ2pRt7@wZ9aBc1_"));
    expect(await onDisk(manifest)).not.toContain("Xk4!mQ2pRt7@wZ9aBc1_");
    // And type_credential's read still resolves it, because reads rehydrate.
    expect((await store.get("reddit"))?.config).toMatchObject({ platform: "reddit", password: "Xk4!mQ2pRt7@wZ9aBc1_" });
});

test("reads rehydrate, so every existing caller still gets a whole capability", async () => {
    const { store } = vaulted();
    await store.upsert(mcp("linear", "mcp_tok_9f2b1c7e4a0d"));
    await store.upsert(mcp("sentry", "mcp_tok_0011223344ff"));
    expect(await store.get("linear")).toEqual({ id: "linear", kind: "mcp", config: { url: "https://a/mcp", token: "mcp_tok_9f2b1c7e4a0d" } });
    expect((await store.list()).map((entry) => (entry.config as { token: string }).token)).toEqual(["mcp_tok_9f2b1c7e4a0d", "mcp_tok_0011223344ff"]);
});

test("re-upserting a capability read WITHOUT rehydration keeps the stored value instead of vaulting the marker", async () => {
    const { store, vaultPath } = vaulted();
    await store.upsert(mcp("linear", "mcp_tok_9f2b1c7e4a0d"));
    // What a caller holding the raw manifest entry would write back — the marker where the value was. Vaulting
    // that would destroy the credential silently, which is the one way this decorator could lose data.
    await store.upsert(mcp("linear", VAULTED));
    expect((await store.get("linear"))?.config).toMatchObject({ token: "mcp_tok_9f2b1c7e4a0d" });
    expect(await onDisk(vaultPath)).toContain("mcp_tok_9f2b1c7e4a0d");
});

test("removing a capability takes its credential with it", async () => {
    const { store, vaultPath } = vaulted();
    await store.upsert(mcp("linear", "mcp_tok_9f2b1c7e4a0d"));
    expect(await store.remove("linear")).toBe(true);
    expect(await onDisk(vaultPath)).not.toContain("mcp_tok_9f2b1c7e4a0d");
    expect(await store.get("linear")).toBeUndefined();
});

test("editing a capability to drop a credential drops it from the vault too", async () => {
    const { store, vaultPath } = vaulted();
    await store.upsert(browser("reddit", "Xk4!mQ2pRt7@wZ9aBc1_"));
    await store.upsert({ id: "reddit", kind: "browser", config: { platform: "reddit" } });
    expect(await onDisk(vaultPath)).not.toContain("Xk4!mQ2pRt7@wZ9aBc1_");
});

test("the vault reports every value it holds — what the output filter masks by value", async () => {
    const root = mkdtempSync(join(tmpdir(), "vault-"));
    const vault = fileSecretVault(join(root, "capability-secrets.json"));
    await vault.set("reddit", { password: "Xk4!mQ2pRt7@wZ9aBc1_" });
    await vault.set("vpnbox", { presharedKey: "K7mNp2qR8tVw3xYz5aBc", config: "conf-body-aaaa" });
    expect((await vault.values()).toSorted()).toEqual(["K7mNp2qR8tVw3xYz5aBc", "Xk4!mQ2pRt7@wZ9aBc1_", "conf-body-aaaa"]);
    await vault.remove("vpnbox");
    expect(await vault.values()).toEqual(["Xk4!mQ2pRt7@wZ9aBc1_"]);
});
