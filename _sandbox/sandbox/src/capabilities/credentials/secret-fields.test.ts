import { CAPABILITY_CATALOG, type CapabilityCatalogEntry } from "@intentic/capability-catalog";
import { fieldApplies } from "@intentic/extension-manifest";
import { type Capability, type CapabilityKind, CapabilitySchema, VAULTED } from "@intentic/sandbox-contract";
import { partitionSecretValues, pastedSecret, secretFieldsOf } from "./secret-fields.js";
import { generateSshKey } from "./ssh-keys.js";

// Pins that a vaulted entry (secret fields replaced by VAULTED) still passes CapabilitySchema; a kind whose echo omits
// a non-secret field would vault it silently and drop the entry on the next read.

const SHA = "9305c108986b03875ea559a7e59f9004df550e7f";

const SAMPLES: Record<CapabilityKind, readonly Capability[]> = {
    devops: [{ id: "devops", kind: "devops", config: {} }],
    monorepo: [{ id: "monorepo", kind: "monorepo", config: {} }],
    mcp: [{ id: "linear", kind: "mcp", config: { url: "https://a/mcp", token: "mcp_tok" } }],
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
        // A key the sandbox generated: its echo adds the public half, which must not keep the private one out of the vault.
        {
            id: "made-box",
            kind: "ssh",
            config: { auth: "generated", host: "h.example.com", port: 22, user: "root", privateKey: generateSshKey("c").privateKey },
        },
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
    netdisk: [
        {
            id: "archive",
            kind: "netdisk",
            config: {
                provider: "smb",
                server: "nas.local",
                share: "archive",
                username: "agent",
                password: "pw",
                access: "read",
                version: "auto",
                autoMount: "on",
            },
        },
        // A guest share: no secret field at all, so vaulting must leave the entry untouched.
        {
            id: "public",
            kind: "netdisk",
            config: {
                provider: "smb",
                server: "nas.local",
                share: "public",
                username: "guest",
                access: "readwrite",
                version: "1.0",
                autoMount: "off",
            },
        },
    ],
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
    device: [
        {
            id: "laptop",
            kind: "device",
            config: {
                platform: "linux",
                shell: "on",
                write: "on",
                screen: "on",
                control: "off",
                sandboxes: "off",
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
    // Every phone field is a permission, not a credential; the echo must be total or a switch is vaulted.
    phone: [
        {
            id: "my-pixel",
            kind: "phone",
            config: {
                platform: "android",
                screen: "on",
                control: "on",
                files: "on",
                write: "on",
                notifications: "on",
                apps: "on",
                destructive: "on",
                confirm: "always",
            },
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
    // One field, and it is the secret: a fleet entry with its token vaulted is a config with nothing else in it, which
    // is the narrowest case this guard has.
    fleet: [{ id: "fleet", kind: "fleet", config: { token: "itk_x" } }],
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

// A token pasted with its trailing newline was refused by every HTTP client as a header value; a PEM key keeps the
// final newline its format needs.
test("a pasted one-line credential is vaulted without its surrounding whitespace, a multi-line one as given", () => {
    expect(pastedSecret("  tok_65chars\n")).toBe("tok_65chars");
    const pem = "-----BEGIN KEY-----\nabc\n-----END KEY-----\n";
    expect(pastedSecret(pem)).toBe(pem);
    const { values } = partitionSecretValues({ id: "fleet", kind: "fleet", config: { token: "itk_x\r\n" } } as Capability, new Map());
    expect(values).toEqual({ token: "itk_x" });
});

// Which fields are credentials is declared twice: the daemon vaults whatever a kind's echo leaves out, and the editor's
// form and the needs gate read `secret: true` off the catalog. A sample is held against every catalog form of its kind
// whose pinned values it carries: each field it fills is vaulted exactly when that form calls it secret, or the form
// shows a credential back to the person, or the daemon writes one into the manifest.
const formsOf = (sample: Capability): CapabilityCatalogEntry[] => {
    const config = sample.config as Record<string, unknown>;
    return CAPABILITY_CATALOG.filter(
        (entry) => entry.kind === sample.kind && entry.fields.every((field) => field.value === undefined || config[field.key] === field.value),
    );
};
const SAMPLE_CASES = Object.entries(SAMPLES).flatMap(([kind, samples]) => samples.map((sample, index) => [`${kind}[${index}]`, sample] as const));

test.each(SAMPLE_CASES)("%s: the catalog calls secret exactly the fields the daemon vaults", (_name, sample) => {
    const config = sample.config as Record<string, unknown>;
    const vaulted = new Set(secretFieldsOf(sample, new Map()));
    const disagreements = formsOf(sample).flatMap((entry) =>
        entry.fields
            .filter((field) => field.value === undefined && field.key in config && fieldApplies(field, config))
            .filter((field) => (field.secret === true) !== vaulted.has(field.key))
            .map((field) => `${entry.id}.${field.key}: the catalog says ${field.secret === true ? "secret" : "plain"}, the daemon ${vaulted.has(field.key) ? "vaults" : "echoes"} it`),
    );
    expect(disagreements).toEqual([]);
});

test("the parity above reads real forms: most kinds' samples meet a catalog form of their own", () => {
    const met = SAMPLE_CASES.filter(([, sample]) => formsOf(sample).length > 0).map(([name]) => name);
    expect(met.length).toBeGreaterThanOrEqual(10);
});
