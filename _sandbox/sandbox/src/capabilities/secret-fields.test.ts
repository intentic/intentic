import { type Capability, type CapabilityKind, CapabilitySchema, VAULTED } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { partitionSecretValues } from "./secret-fields.js";

// Pins that a vaulted entry (secret fields replaced by VAULTED) still passes CapabilitySchema; a kind whose echo omits
// a non-secret field would vault it silently and drop the entry on the next read.

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
    // country is the only non-secret field on tor/vpngate; a dropped echo there loses the whole exit entry.
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
                destructive: "off",
                roots: "/home/me/code",
            },
        },
    ],
    // Every webext field is a permission, not a credential; the echo must be total or a switch is vaulted.
    webext: [
        {
            id: "my-chrome",
            kind: "webext",
            config: { platform: "chrome", read: "on", act: "on", screenshot: "on", cookies: "on", confirm: "always" },
        },
    ],
    agent: [{ id: "codex", kind: "agent", config: { command: "codex", name: "Codex", env: "KEY=value", loginCommand: "codex login" } }],
    endpoint: [
        { id: "ollama", kind: "endpoint", config: { baseUrl: "https://x.example.com", protocol: "openai", apiKey: "sk-x", headers: "X-A: b" } },
    ],
    // Nothing here is a credential; the echo must cover every field including `url`.
    localmodel: [
        {
            id: "qwen",
            kind: "localmodel",
            config: { model: "custom", gpu: "on", url: "https://example.com/m.gguf", context: "custom", contextTokens: 98_304 },
        },
    ],
    // The wallet's signing key never enters this container; every config field is public and must be echoed.
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

// Reproduces what withSecretVault's upsert writes (vaulted keys replaced by the marker) without going through the
// store.
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
        expect(parsed.error?.issues.map((issue) => issue.path.join("."))).toBeUndefined();
        expect(parsed.success).toBe(true);
    },
);

test("an extension's registry stays in the manifest: it is a catalogue fact, not a credential", () => {
    const sample = SAMPLES.extension[0];
    expect(sample).toEqual(expect.any(Object));
    const { values } = partitionSecretValues(sample as Capability, new Map());
    expect(Object.keys(values)).toEqual(["token"]);
});
