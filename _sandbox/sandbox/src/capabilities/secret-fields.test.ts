import { type Capability, type CapabilityKind, CapabilitySchema, VAULTED } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { partitionSecretValues } from "./secret-fields.js";

/* THE INVARIANT THAT TIES THE VAULT TO THE SCHEMA: an entry that has been through the vault must still be a
 * valid entry.
 *
 * The two halves are individually sound and were silently incompatible. `secret-fields.ts` derives the
 * credential keys as the COMPLEMENT of a kind's `echo`, so a field nobody thought to echo is vaulted and the
 * manifest keeps VAULTED in its place. `capabilities-store.ts` validates each entry against CapabilitySchema on
 * READ, before the vault is consulted: correctly, because the store must not need the vault to know whether a
 * file is a manifest. Put together, a vaulted field whose schema refuses the marker string produces an entry
 * that can be written and never read again: it fails validation, and one bad entry is SKIPPED so the rest
 * survive (the right blast radius, and the reason this is silent).
 *
 * What that cost: the extension kind echoed neither `tier` nor `registry`, and the Discover page attaches the
 * registry it browsed to every install. So every extension installed from Discover was vaulted into an entry
 * whose `registry` was no longer a url, dropped from the capability list on the next read, and therefore absent
 * from the extension inventory that list is built from: no row, no on/off switch, no view, no settings, no
 * CLI on the agent's PATH, and Discover still offering "Install" for something already on disk. The ipsec vpn
 * arm had the same shape waiting in three enum-and-CIDR dial parameters.
 *
 * So the guard is per KIND rather than per bug, and total over CapabilityKind: a new kind with an incomplete
 * echo fails here instead of in somebody's sandbox a release later. Arms of a discriminated union get their own
 * sample, because the echo branches on the discriminant and so does the schema. Samples are deliberately
 * MAXIMAL: every optional field populated, since an unpopulated field is not vaulted and proves nothing. */

const SHA = "9305c108986b03875ea559a7e59f9004df550e7f";

const SAMPLES: Record<CapabilityKind, readonly Capability[]> = {
    devops: [{ id: "devops", kind: "devops", config: {} }],
    monorepo: [{ id: "monorepo", kind: "monorepo", config: {} }],
    mcp: [{ id: "linear", kind: "mcp", config: { url: "https://a/mcp", token: "mcp_tok" } }],
    service: [{ id: "outline", kind: "service", config: { service: "outline", domain: "docs.example.com", on: "hetzner", expose: "public" } }],
    integration: [{ id: "stripe", kind: "integration", config: { provider: "stripe" } }],
    cli: [{ id: "github", kind: "cli", config: { provider: "github", token: "ghp_x", git: "on" } }],
    plugin: [{ id: "iq", kind: "plugin", config: { url: "https://github.com/a/b.git", ref: "main", path: "sub", token: "ghp_x" } }],
    extension: [
        {
            id: "intentic-example",
            kind: "extension",
            config: {
                url: "https://github.com/intentic/extension-example.git",
                ref: SHA,
                path: "sub",
                token: "ghp_x",
                tier: "premium",
                registry: "https://registry.example.com/registry.json",
            },
        },
    ],
    ssh: [
        { id: "build-box", kind: "ssh", config: { auth: "key", host: "h.example.com", port: 22, user: "root", privateKey: "-----BEGIN-----" } },
        { id: "jump", kind: "ssh", config: { auth: "password", host: "h.example.com", port: 22, user: "root", password: "pw" } },
    ],
    vpn: [
        { id: "wg", kind: "vpn", config: { provider: "wireguard", config: "[Interface]\nPrivateKey=x", autoConnect: "on" } },
        {
            id: "forti",
            kind: "vpn",
            config: {
                provider: "fortinet",
                server: "gw.example.com",
                port: 443,
                username: "u",
                password: "pw",
                trustedCert: "sha256:0badc0ffee",
                realm: "contractors",
                autoConnect: "on",
            },
        },
        {
            id: "ipsec",
            kind: "vpn",
            config: {
                provider: "ipsec",
                server: "gw.example.com",
                presharedKey: "psk",
                localId: "local",
                remoteId: "remote",
                username: "u",
                password: "pw",
                ikeVersion: "1",
                pfs: "on",
                dhGroup: "14",
                aggressive: "on",
                routedNetworks: "10.0.0.0/8",
                autoConnect: "on",
            },
        },
    ],
    /* All three exit arms, each with `country` populated, which is the field this guard is actually about
     * here: it is the only non-secret one on the tor and vpngate arms, so if it were ever dropped from the
     * echo the vault would replace it with VAULTED, CountryCodeSchema would refuse that on the next read, and
     * the whole exit would vanish from the manifest rather than one label going missing. */
    exit: [
        { id: "tor-exit", kind: "exit", config: { provider: "tor", country: "DE", autoStart: "on" } },
        { id: "vpngate-exit", kind: "exit", config: { provider: "vpngate", country: "JP", autoStart: "off" } },
        {
            id: "byo-exit",
            kind: "exit",
            config: { provider: "wireguard", config: "[Interface]\nPrivateKey=x", country: "NL", autoStart: "off" },
        },
    ],
    docker: [
        {
            id: "docker",
            kind: "docker",
            config: { gpu: "on", registryMirror: "https://mirror.example.com", insecureRegistries: "reg:5000", addressPool: "10.1.0.0/16" },
        },
    ],
    browser: [{ id: "reddit", kind: "browser", config: { platform: "reddit", username: "u", password: "pw", identity: "identity" } }],
    identity: [
        {
            id: "identity",
            kind: "identity",
            config: { email: "a@example.com", password: "pw", mailbox: "gmail", loginUrl: "https://mail.example.com", openAccounts: "on" },
        },
    ],
    host: [
        {
            id: "laptop",
            kind: "host",
            config: {
                platform: "linux",
                shell: "on",
                write: "on",
                screen: "on",
                control: "off",
                sandboxes: "off",
                sandboxRemove: "off",
                roots: "/home/me/code",
            },
        },
    ],
    agent: [{ id: "codex", kind: "agent", config: { command: "codex", name: "Codex", env: "KEY=value", loginCommand: "codex login" } }],
    endpoint: [
        { id: "ollama", kind: "endpoint", config: { baseUrl: "https://x.example.com", protocol: "openai", apiKey: "sk-x", headers: "X-A: b" } },
    ],
    // Nothing here is a credential (public weights, an unauthenticated loopback server), so the echo must
    // cover every field — `url` included, the one an incomplete echo would silently vault.
    localmodel: [{ id: "qwen", kind: "localmodel", config: { model: "custom", gpu: "on", url: "https://example.com/m.gguf" } }],
    // Maximal like every sample here, and the kind with the least to hide: the wallet's signing key never
    // enters this container, so its config is an address and the owner's own policy numbers: every one of
    // which the handler echoes, which is exactly what this guard is checking it still does.
    wallet: [
        {
            id: "wallet",
            kind: "wallet",
            config: {
                network: "eip155:8453",
                address: "0x857b06519E91e3A54538791bDbb0E22373e36b66",
                perPaymentMaxUsd: "1.00",
                autoApproveUnderUsd: "0.25",
                dailyCapUsd: "5.00",
                allow: "api.example.com",
                deny: "sketchy.example",
            },
        },
    ],
};

// Exactly what withSecretVault's upsert writes: the vaulted keys replaced by the marker, everything else as it
// came in. Reproduced rather than driven through the store so the failure names the kind and not a file path.
const asWritten = (capability: Capability): Capability => {
    const { values } = partitionSecretValues(capability, new Map());
    const config = { ...(capability.config as Record<string, unknown>) };
    for (const key of Object.keys(values)) {
        config[key] = VAULTED;
    }
    return { ...capability, config } as Capability;
};

test.each(Object.entries(SAMPLES).flatMap(([kind, samples]) => samples.map((sample, index) => [`${kind}[${index}]`, sample] as const)))(
    "%s survives the vault round-trip and still validates",
    (_name, sample) => {
        const written = asWritten(sample);
        const parsed = CapabilitySchema.safeParse(written);
        // The marker's own contract (capabilities-store.ts) is that the entry STILL SATISFIES the schema with it
        // in place. A failure here names the field whose echo is missing.
        expect(parsed.error?.issues.map((issue) => issue.path.join("."))).toBeUndefined();
        expect(parsed.success).toBe(true);
    },
);

// The vault is not a place to hide config: what leaves the manifest must be a credential, and the only way this
// stays true is that nothing NON-secret is in the complement of the echo. Pinned for the kind whose echo the
// install path depends on, with the two fields that were missing named outright.
test("an extension's registry and tier stay in the manifest: they are catalogue facts, not credentials", () => {
    const sample = SAMPLES.extension[0];
    expect(sample).toBeDefined();
    const { values } = partitionSecretValues(sample as Capability, new Map());
    expect(Object.keys(values)).toEqual(["token"]);
});
