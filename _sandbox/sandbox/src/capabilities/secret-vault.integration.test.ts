import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STATE_DIR } from "@intentic/constants";
import { type Capability, VAULTED } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { type CapabilitiesStore, fileCapabilitiesStore, vaultManifestSecrets, withSecretVault } from "./capabilities-store.js";
import { fileSecretVault, type SecretVault } from "./secret-vault.js";

/* THE POINT OF THE SPLIT, pinned: the file the agent can open holds the shape of a connection and never the
 * credential in it, while every reader of the store still gets a whole Capability. Both halves matter — the
 * first is the exposure this closes, the second is why no call site had to change. */

const vaulted = (): { store: CapabilitiesStore; manifest: string; vaultPath: string } => {
    const root = mkdtempSync(join(tmpdir(), "vault-"));
    const manifest = join(root, STATE_DIR, "config", "capabilities.json");
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

/* THE SWEEP: the split as an invariant, not a habit of the write path.
 *
 * `upsert` is the only thing that vaults, so it only ever covered entries saved SINCE it existed. A service
 * connected before the split, an entry the agent pasted a real token back into with its own file tools, or one
 * restored from an export all sit in a readable file with the credential in them — and nothing re-saves a
 * service that is working. These pin the boot sweep that answers for them.
 */

const swept = (): { inner: CapabilitiesStore; vault: SecretVault; manifest: string; sweep: () => Promise<readonly string[]> } => {
    const root = mkdtempSync(join(tmpdir(), "sweep-"));
    const manifest = join(root, STATE_DIR, "config", "capabilities.json");
    const inner = fileCapabilitiesStore(manifest);
    const vault = fileSecretVault(join(root, "auth", "capability-secrets.json"));
    return { inner, vault, manifest, sweep: () => vaultManifestSecrets(inner, vault, async () => new Map()) };
};

test("a credential sitting in the manifest is moved into the vault and named in the answer", async () => {
    const { inner, vault, manifest, sweep } = swept();
    // Written through the RAW store — exactly the state a pre-split save (or a hand-edit) leaves behind.
    await inner.upsert(mcp("linear", "mcp_tok_9f2b1c7e4a0d"));
    expect(await onDisk(manifest)).toContain("mcp_tok_9f2b1c7e4a0d");

    expect(await sweep()).toEqual(["linear"]);
    expect(await onDisk(manifest)).not.toContain("mcp_tok_9f2b1c7e4a0d");
    expect(await onDisk(manifest)).toContain(VAULTED);
    expect(await vault.get("linear")).toEqual({ token: "mcp_tok_9f2b1c7e4a0d" });
    // The connection still works: a rehydrating read hands back the whole capability.
    expect((await withSecretVault(inner, vault, async () => new Map()).get("linear"))?.config).toMatchObject({
        url: "https://a/mcp",
        token: "mcp_tok_9f2b1c7e4a0d",
    });
});

test("an already-correct manifest is not rewritten — no churn on every restart", async () => {
    const { inner, vault, manifest, sweep } = swept();
    await withSecretVault(inner, vault, async () => new Map()).upsert(browser("reddit", "Xk4!mQ2pRt7@wZ9aBc1_"));
    const before = await onDisk(manifest);

    // Nothing to move, so nothing is named and the file (and its watchers) are left alone.
    expect(await sweep()).toEqual([]);
    expect(await onDisk(manifest)).toBe(before);
});

test("a value in BOTH places keeps the vault's — the one a working service authenticates with", async () => {
    // `hydrate` gives the vault priority, so this is already the credential in use. Moving the manifest's stale
    // copy in would silently swap it and break a connection that was working.
    const { inner, vault, sweep } = swept();
    await inner.upsert(mcp("linear", "mcp_tok_stale00000000"));
    await vault.set("linear", { token: "mcp_tok_9f2b1c7e4a0d" });

    expect(await sweep()).toEqual(["linear"]);
    expect(await vault.get("linear")).toEqual({ token: "mcp_tok_9f2b1c7e4a0d" });
});

test("an entry with no credential at all is left where it is", async () => {
    const { inner, manifest, sweep } = swept();
    await inner.upsert({ id: "devops", kind: "devops", config: {} });
    const before = await onDisk(manifest);
    expect(await sweep()).toEqual([]);
    expect(await onDisk(manifest)).toBe(before);
});

test("the sweep moves every entry that needs it, not just the first", async () => {
    const { inner, vault, manifest, sweep } = swept();
    await inner.upsert(mcp("linear", "mcp_tok_9f2b1c7e4a0d"));
    await inner.upsert(browser("reddit", "Xk4!mQ2pRt7@wZ9aBc1_"));
    await inner.upsert(mcp("sentry", "mcp_tok_0011223344ff"));

    expect((await sweep()).toSorted()).toEqual(["linear", "reddit", "sentry"]);
    const written = await onDisk(manifest);
    for (const secret of ["mcp_tok_9f2b1c7e4a0d", "Xk4!mQ2pRt7@wZ9aBc1_", "mcp_tok_0011223344ff"]) {
        expect(written).not.toContain(secret);
    }
    expect((await vault.values()).toSorted()).toEqual(["Xk4!mQ2pRt7@wZ9aBc1_", "mcp_tok_0011223344ff", "mcp_tok_9f2b1c7e4a0d"]);
});

test("the sweep is idempotent — a second boot moves nothing", async () => {
    const { inner, manifest, sweep } = swept();
    await inner.upsert(mcp("linear", "mcp_tok_9f2b1c7e4a0d"));
    expect(await sweep()).toEqual(["linear"]);
    const after = await onDisk(manifest);
    expect(await sweep()).toEqual([]);
    expect(await onDisk(manifest)).toBe(after);
});

test("a secret pasted back into the manifest is swept out again — the state is re-enterable", async () => {
    // The manifest is meant to be editable, so "a credential is in there" is not a leftover of one version: the
    // agent can put one back at any time with its own file tools. A conversion that ran once would miss this
    // second arrival; a sweep every boot does not.
    const { inner, vault, manifest, sweep } = swept();
    await inner.upsert(mcp("linear", "mcp_tok_9f2b1c7e4a0d"));
    await sweep();
    await inner.upsert(mcp("linear", "mcp_tok_pasted_back01"));

    expect(await sweep()).toEqual(["linear"]);
    // Out of the readable file — which is the whole exposure.
    expect(await onDisk(manifest)).not.toContain("mcp_tok_pasted_back01");
    /* And the working credential is NOT swapped for the pasted one. That edit was already inert before the
     * sweep ran — reads rehydrate, so the vault's value is what every caller has been authenticating with — so
     * adopting it here would be the sweep CHANGING a live connection rather than tidying a file. */
    expect(await vault.get("linear")).toEqual({ token: "mcp_tok_9f2b1c7e4a0d" });
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
