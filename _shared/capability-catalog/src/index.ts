// Platform UI/product catalogs: add-form descriptors and card data the web renders. Not wire contract; the contract
// holds only schemas, daemon enums are imported here.
import { type CapabilityContribution, type CapabilityField, contributionDiscriminator } from "@intentic/extension-manifest";
import {
    type CapabilityKind,
    type ExitPoint,
    LOCAL_MODEL_WINDOW_DEFAULT,
    LOCAL_MODEL_WINDOWS,
    type LocalModelWindow,
    type ServiceKind,
    TOR_EXIT_COUNTRIES,
    VPNGATE_EXIT_COUNTRIES,
} from "@intentic/sandbox-contract";

// GB cost per rung (~1 GB/16k, q8_0 cache); typed against the rung list so a new one must price itself.
const WINDOW_LABELS: Record<LocalModelWindow, string> = {
    "16384": "16k · 1 GB",
    "32768": "32k · 2 GB",
    "65536": "64k · 4 GB",
    "131072": "128k · 8 GB",
};

// Weights (GB) behind each model label; a custom GGUF has none, since its memory was the user's own choice.
const LOCAL_MODEL_WEIGHTS_GB: Readonly<Record<string, number>> = {
    "unsloth/Phi-4-mini-instruct-GGUF/Phi-4-mini-instruct-Q4_K_M.gguf": 3,
    "unsloth/Qwen3.5-9B-GGUF/Qwen3.5-9B-Q4_K_M.gguf": 6,
    "unsloth/gemma-4-12b-it-GGUF/gemma-4-12b-it-Q4_K_M.gguf": 14,
    "unsloth/Qwen3.8-27B-GGUF/Qwen3.8-27B-UD-Q4_K_M.gguf": 22,
};

// RAM ask computed from the form: ~1 GB cache per 16k window, on top of the chosen weights. Either half missing (custom
// GGUF, unparsed window) leaves its figure and the total undefined; wrong is worse than none.
export interface LocalModelMemory {
    readonly weightsGb: number | undefined;
    readonly windowGb: number | undefined;
    readonly totalGb: number | undefined;
}
export const localModelMemory = (config: Readonly<Record<string, string | undefined>>): LocalModelMemory => {
    const weightsGb = LOCAL_MODEL_WEIGHTS_GB[config["model"] ?? ""];
    const tokens = Number(config["context"] === "custom" ? config["contextTokens"] : config["context"]);
    const windowGb = Number.isInteger(tokens) && tokens > 0 ? Math.max(1, Math.round(tokens / 16_384)) : undefined;
    return { weightsGb, windowGb, totalGb: weightsGb !== undefined && windowGb !== undefined ? weightsGb + windowGb : undefined };
};

// One country in the geo-exit picker; the capacity share rides in the label so a thin exit doesn't look identical to a
// healthy one in the list.
const countryOption = (point: ExitPoint): { value: string; label: string } => ({
    value: point.country,
    label: `${point.countryName}${point.share === undefined ? "" : ` — ${point.share >= 0.01 ? Math.round(point.share * 100) : "<1"}% of capacity`}`,
});

// Catalog the web renders add forms from; only user-provided, non-secret fields appear. Servers and Cloudflare register
// through their own connect steps, never a bare form.
export interface InventoryFieldDescriptor {
    readonly key: string;
    readonly label: string;
    readonly kind: "text" | "number";
}
// Self-hosted service catalog for the infra operator panel's "Add service" dialog: one card per deployable service,
// then its fields form.
export interface InventoryServiceDescriptor {
    readonly service: ServiceKind;
    readonly label: string;
    readonly logo?: string | undefined;
    // An @intentic/ui IconName fallback glyph, rendered when no simple-icons `logo` fits the brand.
    readonly icon?: string | undefined;
    readonly description: string;
    readonly fields: readonly InventoryFieldDescriptor[];
}
export const INVENTORY_SERVICES: readonly InventoryServiceDescriptor[] = [
    {
        service: "signoz",
        label: "SigNoz",
        icon: "wave-pulse",
        description: "Observability, traces, logs and metrics.",
        fields: [{ key: "domain", label: "Domain", kind: "text" }],
    },
    {
        service: "outline",
        label: "Outline",
        logo: "outline",
        description: "Team wiki and docs.",
        fields: [{ key: "domain", label: "Domain", kind: "text" }],
    },
    {
        service: "paperless",
        label: "Paperless-ngx",
        logo: "paperlessngx",
        description: "Scan, index and archive documents.",
        fields: [{ key: "domain", label: "Domain", kind: "text" }],
    },
    {
        service: "openproject",
        label: "OpenProject",
        logo: "openproject",
        description: "Project management and issue tracking.",
        fields: [{ key: "domain", label: "Domain", kind: "text" }],
    },
    {
        service: "invoiceninja",
        label: "Invoice Ninja",
        logo: "invoiceninja",
        description: "Invoicing, quotes and payments.",
        fields: [{ key: "domain", label: "Domain", kind: "text" }],
    },
    {
        // No infisical slug in simple-icons; uses the semantic lock glyph instead.
        service: "infisical",
        label: "Infisical",
        icon: "lock",
        description: "Secrets management for apps and teams.",
        fields: [{ key: "domain", label: "Domain", kind: "text" }],
    },
];

// POST /capabilities body: id, kind, and kind-specific config built from the form; the daemon validates the
// discriminated shape. Values are strings; empty optional fields are omitted.
export interface AddCapabilityInput {
    readonly id: string;
    readonly kind: CapabilityKind;
    readonly config: Record<string, string>;
}

// CapabilityField (from @intentic/extension-api) is shared by static cards and extension manifests.
// secret: withholds the value from every echo.
// value: pins a field the user never sees (a discriminator).
// when: gates a field on the answers already given.
// multiline: keeps the newlines a pasted PEM needs.

// Display grouping in the "+" grid, by what a card is for, not its technical `kind`. `platform` cards unlock a new
// workspace area; the rest connect existing tools.
export type CapabilityCategory =
    "platform" | "code" | "observability" | "data" | "communication" | "business" | "devices" | "servers" | "deploy" | "extend";

// The grid's sections, in render order, with their headers. Cards are grouped by `category` under these.
export const CAPABILITY_CATEGORIES: readonly { readonly id: CapabilityCategory; readonly label: string; readonly hint: string }[] = [
    { id: "platform", label: "Platform", hint: "Scaffold managed repos that appear as their own operator panels." },
    { id: "code", label: "Code & issues", hint: "Repos, issues and pipelines as agent tools." },
    { id: "observability", label: "Observability", hint: "Query errors, traces, logs and metrics." },
    { id: "data", label: "Data", hint: "Let the agent query your SQL databases." },
    { id: "communication", label: "Communication", hint: "Let the agent read and send messages." },
    { id: "business", label: "Business & docs", hint: "Connect payments and knowledge bases." },
    // Distinct from Servers: a server is something the sandbox dials, a device is something that dials the sandbox.
    { id: "devices", label: "Your devices", hint: "Let the agent work on your own device, run commands, handle files, see the screen." },
    { id: "servers", label: "Servers", hint: "Give the agent remote machines over SSH and private networks over VPN." },
    { id: "deploy", label: "Deploy & infra", hint: "Drive your container deployments, stacks, services and releases." },
    { id: "extend", label: "Extend", hint: "Add any MCP server or Claude Code plugin." },
];

// How to get a card's credential, shown as an always-open panel (scopes, steps, a token link); hosted uses `url`,
// self-hostable builds the link from `urlFromField` + `path`. Backtick a literal in `scopes`/`steps` for a chip.
export interface CapabilityGuide {
    readonly url?: string | undefined;
    readonly urlFromField?: string | undefined;
    readonly path?: string | undefined;
    // Overrides the default "Create a token" link label.
    readonly linkLabel?: string | undefined;
    // The subtle "Scopes: …" line under the link, the permissions the token needs.
    readonly scopes?: string | undefined;
    // Ordered how-to-get-it steps, revealed in an InfoHint disclosure.
    readonly steps?: readonly string[] | undefined;
}

// This package is a kind's whole story: cards declare the form, effects.ts declares the consequence.
export * from "./effects.js";

// The grid the rail's "+" renders; a card is a capability type; the user names each instance, so a provider can have N.
// `requires` cards show but stay gated until the prereq is active.
export interface CapabilityCatalogEntry {
    readonly id: string;
    readonly name: string;
    readonly kind: CapabilityKind;
    readonly category: CapabilityCategory;
    // A simple-icons slug; a "/<hex>" suffix forces a color for icons invisible on the dark canvas.
    readonly logo?: string | undefined;
    // An @intentic/ui IconName shown when no simple-icons `logo` fits; undefined falls to the generic per-kind icon.
    readonly icon?: string | undefined;
    // One line, 60 characters or fewer; the grid clamps to two lines and a longer story belongs in `hint`.
    readonly description: string;
    readonly requires?: readonly CapabilityKind[] | undefined;
    readonly fields: readonly CapabilityField[];
    // Paragraph under the add-form, also searched, so a card stays findable by words `description` had no room for.
    readonly hint?: string | undefined;
    readonly guide?: CapabilityGuide | undefined;
    // True when there's nothing to name or duplicate (e.g. Docker Engine); opens pre-filled from the live instance.
    readonly singleton?: boolean | undefined;
}

// Permission switches every device card carries; shared so platforms can't drift into different defaults.
const HOST_SCOPE_FIELDS: readonly CapabilityField[] = [
    {
        key: "shell",
        label: "Run commands",
        default: "on",
        options: [
            { value: "on", label: "Allowed" },
            { value: "off", label: "Blocked" },
        ],
    },
    {
        key: "write",
        label: "Create and change files",
        default: "off",
        options: [
            { value: "off", label: "Blocked" },
            { value: "on", label: "Allowed" },
        ],
    },
    {
        key: "screen",
        label: "See the screen",
        default: "on",
        options: [
            { value: "on", label: "Allowed" },
            { value: "off", label: "Blocked" },
        ],
    },
    {
        key: "control",
        label: "Use the mouse and keyboard",
        default: "off",
        options: [
            { value: "off", label: "Blocked" },
            { value: "on", label: "Allowed" },
        ],
    },
    {
        key: "sandboxes",
        label: "Manage sandboxes on this device",
        default: "off",
        options: [
            { value: "off", label: "Blocked" },
            { value: "on", label: "Allowed" },
        ],
        hint: "Start, stop and update this machine's Intentic sandboxes.",
    },
    {
        key: "sandboxRemove",
        label: "Remove sandboxes from this device",
        default: "off",
        options: [
            { value: "off", label: "Blocked" },
            { value: "on", label: "Allowed" },
        ],
        hint: "Deletes a sandbox with its files and history: nothing undoes it.",
    },
    {
        key: "destructive",
        label: "Run destructive commands",
        default: "off",
        options: [
            { value: "off", label: "Blocked" },
            { value: "on", label: "Allowed" },
        ],
        hint: "Deleting folders recursively, formatting a disk, removing a Docker volume. Everything else it may run stays allowed.",
    },
    {
        key: "roots",
        label: "Folders it may touch",
        optional: true,
        multiline: true,
        placeholder: "One folder per line. Leave empty for your home folder.",
    },
];

export const CAPABILITY_CATALOG: readonly CapabilityCatalogEntry[] = [
    {
        id: "devops",
        name: "DevOps",
        kind: "devops",
        category: "platform",
        description: "Self-host and deploy your own apps.",
        fields: [],
        hint: "One-time setup, then provision hosts, services and apps.",
    },
    {
        id: "monorepo",
        name: "pnpm + turbo monorepo",
        kind: "monorepo",
        category: "platform",
        description: "Scaffold an empty pnpm + turbo monorepo.",
        fields: [],
        hint: "Names the repo. Once it's created, open its panel to add a Hono API, a Vue web app, or an Astro landing page.",
    },
    {
        id: "stripe",
        name: "Stripe",
        kind: "integration",
        category: "business",
        logo: "stripe",
        description: "Connect Stripe for the agent and your app.",
        requires: ["devops"],
        fields: [{ key: "provider", label: "", value: "stripe" }],
        hint: "The API key is read from your sandbox env (STRIPE_API_KEY) on the next provision.",
    },
    {
        id: "docker",
        name: "Docker",
        kind: "docker",
        category: "platform",
        logo: "docker",
        description: "Run containers, its own Engine + Compose.",
        singleton: true,
        // These fields are choices about the engine, not its config; the `rebuild` chip marks which ones need a rebuild
        // vs a dockerd restart. `--privileged` isn't a field: dockerd requires it, so it's disclosed by the effects
        // panel instead.
        fields: [
            {
                key: "gpu",
                label: "GPU access",
                boolean: true,
                default: "off",
                rebuild: true,
                hint: "Needs an NVIDIA GPU and nvidia-container-toolkit on the host.",
            },
            {
                key: "registryMirror",
                label: "Registry mirror",
                optional: true,
                advanced: true,
                placeholder: "https://registry.example.internal",
                hint: "A pull-through cache for Docker Hub.",
            },
            {
                key: "insecureRegistries",
                label: "Insecure registries",
                optional: true,
                advanced: true,
                placeholder: "registry.lan:5000",
                hint: "Plain-http or self-signed registries, comma-separated.",
            },
            {
                key: "addressPool",
                label: "Container address pool",
                optional: true,
                advanced: true,
                placeholder: "10.201.0.0/16",
                hint: "Change it when 172.17.0.0/16 collides with your VPN or LAN.",
            },
        ],
        hint: "One-time rebuild: the sandbox gets its own isolated Docker Engine.",
    },
    {
        id: "ssh",
        name: "SSH",
        kind: "ssh",
        category: "servers",
        icon: "server",
        description: "Operate a remote machine over SSH.",
        fields: [
            { key: "host", label: "Host", placeholder: "1.2.3.4 or box.example.com" },
            { key: "port", label: "Port", default: "22" },
            { key: "user", label: "User", placeholder: "root" },
            {
                key: "auth",
                label: "Authentication",
                default: "key",
                options: [
                    { value: "key", label: "Private key" },
                    { value: "password", label: "Password" },
                ],
            },
            { key: "privateKey", label: "Private key", secret: true, multiline: true, when: "auth == 'key'" },
            { key: "password", label: "Password", secret: true, when: "auth == 'password'" },
        ],
        hint: 'The name is the alias the agent uses (ssh <name> "…").',
        guide: {
            steps: [
                "Generate a dedicated key: `ssh-keygen -t ed25519 -f agent_key`.",
                "Add `agent_key.pub` to the server's `authorized_keys`.",
                "Paste the unencrypted private key here.",
                "Or switch to `Password` and paste that instead.",
            ],
        },
    },
    {
        id: "vpn",
        name: "VPN",
        kind: "vpn",
        category: "servers",
        icon: "shield",
        description: "WireGuard, FortiGate or IPsec.",
        fields: [
            // The discriminator: every field below gates on it, so one card serves three protocols as one config union.
            {
                key: "provider",
                label: "Type",
                default: "wireguard",
                options: [
                    { value: "wireguard", label: "WireGuard" },
                    { value: "fortinet", label: "FortiGate SSL-VPN" },
                    { value: "ipsec", label: "IPsec" },
                ],
            },
            {
                key: "config",
                label: "WireGuard config",
                secret: true,
                multiline: true,
                placeholder: "[Interface]\nPrivateKey = …\n\n[Peer]\n…",
                when: "provider == 'wireguard'",
            },

            // FortiGate SSL-VPN, the <sslvpn> connections in a FortiClient export. Import fills these in.
            { key: "server", label: "Gateway", placeholder: "vpn.example.com", when: "provider == 'fortinet'" },
            { key: "port", label: "Port", default: "443", when: "provider == 'fortinet'" },
            { key: "username", label: "Username", when: "provider == 'fortinet'" },
            { key: "password", label: "Password", secret: true, when: "provider == 'fortinet'" },
            {
                key: "realm",
                label: "Realm / user group",
                optional: true,
                advanced: true,
                placeholder: "only if your gateway uses one",
                when: "provider == 'fortinet'",
            },
            {
                key: "trustedCert",
                label: "Trusted certificate",
                optional: true,
                advanced: true,
                placeholder: "sha256:… (only for a self-signed gateway)",
                when: "provider == 'fortinet'",
            },

            // IPsec, the <ipsecvpn> connections in a FortiClient export.
            { key: "server", label: "Gateway", placeholder: "vpn.example.com", when: "provider == 'ipsec'" },
            { key: "presharedKey", label: "Pre-shared key", secret: true, when: "provider == 'ipsec'" },
            {
                key: "localId",
                label: "Local ID",
                optional: true,
                placeholder: "the group name your gateway expects",
                when: "provider == 'ipsec'",
            },
            { key: "username", label: "XAuth username", optional: true, when: "provider == 'ipsec'" },
            { key: "password", label: "XAuth password", secret: true, optional: true, when: "provider == 'ipsec'" },
            // Phase-1/phase-2 knobs, folded: defaults match a stock FortiGate, and import sets them all anyway.
            {
                key: "ikeVersion",
                label: "IKE version",
                default: "1",
                advanced: true,
                options: [
                    { value: "1", label: "IKEv1" },
                    { value: "2", label: "IKEv2" },
                ],
                when: "provider == 'ipsec'",
            },
            {
                key: "pfs",
                label: "Perfect Forward Secrecy",
                default: "on",
                advanced: true,
                options: [
                    { value: "on", label: "On" },
                    { value: "off", label: "Off" },
                ],
                when: "provider == 'ipsec'",
            },
            {
                key: "dhGroup",
                label: "DH group",
                default: "14",
                advanced: true,
                options: [
                    { value: "14", label: "14 (2048)" },
                    { value: "5", label: "5 (1536)" },
                    { value: "2", label: "2 (1024)" },
                    { value: "15", label: "15 (3072)" },
                    { value: "16", label: "16 (4096)" },
                    { value: "19", label: "19 (ECP256)" },
                    { value: "20", label: "20 (ECP384)" },
                ],
                when: "provider == 'ipsec'",
            },
            {
                key: "aggressive",
                label: "Aggressive mode",
                default: "on",
                advanced: true,
                options: [
                    { value: "on", label: "On" },
                    { value: "off", label: "Off" },
                ],
                when: "provider == 'ipsec'",
            },
            // That one ipsec setting whose wrong value has no symptom: a gateway that won't route 0.0.0.0/0 just goes
            // quiet.
            {
                key: "routedNetworks",
                label: "Routed networks",
                default: "0.0.0.0/0",
                placeholder: "10.0.0.0/8,192.168.0.0/16",
                hint: "0.0.0.0/0 sends everything through the gateway, this sandbox's own internet included.",
                when: "provider == 'ipsec'",
            },

            // The only persisted connection intent; connecting itself is a live action on this card.
            {
                key: "autoConnect",
                label: "Connect automatically",
                default: "on",
                options: [
                    { value: "on", label: "On" },
                    { value: "off", label: "Off" },
                ],
            },
        ],
        hint: "Connect and disconnect right here, on the connection you added (the agent can too).",
        guide: {
            steps: [
                "Have a FortiClient file? `Import from FortiClient` fills this in.",
                "WireGuard: paste the full `.conf` (`[Interface]` + `[Peer]`).",
                "FortiGate: the gateway host and port FortiClient dials.",
                "IPsec: pre-shared key, plus XAuth if the gateway asks.",
                "2FA gateway? Press `Connect` on its row below and enter the code there.",
            ],
        },
    },
    {
        id: "exit",
        name: "Geo exit",
        kind: "exit",
        category: "servers",
        icon: "globe",
        description: "Browse and fetch as if from another country.",
        fields: [
            // Discriminator ordered by reader cost: tor first, nothing needed; paste-your-own last, the only one that
            // asks.
            {
                key: "provider",
                label: "Provider",
                default: "tor",
                hint: "Tor needs no account; paste WireGuard for a provider you already have.",
                options: [
                    { value: "tor", label: "Tor (free, ~28 countries)" },
                    { value: "vpngate", label: "VPN Gate (free, Japan/Korea)" },
                    { value: "wireguard", label: "Paste WireGuard configs" },
                ],
            },
            // Per-provider picker, sorted best-supplied first; the server itself is never asked for, the driver picks
            // one.
            {
                key: "country",
                label: "Come out in",
                optional: true,
                default: "",
                hint: "Switchable any time afterwards, no re-adding.",
                when: "provider == 'tor'",
                options: [{ value: "", label: "Anywhere (fastest)" }, ...TOR_EXIT_COUNTRIES.map(countryOption)],
            },
            {
                key: "country",
                label: "Come out in",
                optional: true,
                default: "",
                hint: "For anywhere outside Japan/Korea, use Tor instead.",
                when: "provider == 'vpngate'",
                options: [{ value: "", label: "Anywhere (fastest)" }, ...VPNGATE_EXIT_COUNTRIES.map(countryOption)],
            },
            {
                key: "config",
                label: "WireGuard configs",
                secret: true,
                multiline: true,
                placeholder:
                    "[Interface]\nPrivateKey = …\nAddress = 10.2.0.2/32\n\n[Peer]\n# DE-FREE#1\nPublicKey = …\nEndpoint = …:51820\n\n[Interface]\n… paste the next country's file straight after …",
                hint: "One file per country, back to back. `# country: DE` places one the reader can't.",
                when: "provider == 'wireguard'",
            },
            {
                key: "country",
                label: "Start in",
                optional: true,
                placeholder: "DE",
                hint: "Empty means the first file above.",
                when: "provider == 'wireguard'",
            },
            // Off by default, opposite of the VPN card: an exit costs bandwidth, starts on demand when something needs
            // it.
            {
                key: "autoStart",
                label: "Start automatically",
                default: "off",
                advanced: true,
                hint: "Off: it comes up when something asks for it.",
                options: [
                    { value: "off", label: "Off" },
                    { value: "on", label: "On" },
                ],
            },
        ],
        hint: "Nothing routes through an exit unless you point it there: the sandbox's own connection never changes.",
        guide: {
            steps: [
                "Tor and VPN Gate: nothing to fill in. Pick a country, add.",
                "Proton VPN free: `account.protonvpn.com` → `Downloads` → `WireGuard configuration`, one config per country.",
                "Mullvad: `mullvad.net/account` → `WireGuard configuration`.",
                "Paste several files in the one box: they become one pool.",
                "Switch later from this card or `geo use <name> DE`.",
                "These are datacenter addresses: sites that check will see a proxy.",
            ],
        },
    },
    {
        id: "custom",
        name: "Custom MCP server",
        kind: "mcp",
        category: "extend",
        description: "Any remote MCP server, by URL and token.",
        fields: [
            { key: "url", label: "MCP URL", placeholder: "https://example.com/mcp" },
            { key: "token", label: "Token", secret: true, optional: true },
        ],
        guide: {
            steps: ["Paste the server's URL (Streamable HTTP or SSE).", "Needs auth? Paste a bearer token.", "The agent connects next turn."],
        },
    },
    {
        id: "plugin",
        name: "Claude plugin",
        kind: "plugin",
        category: "extend",
        description: "A Claude Code plugin from a git repo.",
        fields: [
            { key: "url", label: "Git URL", placeholder: "https://github.com/owner/plugin" },
            { key: "ref", label: "Branch, tag or commit", optional: true },
            { key: "path", label: "Subdirectory", optional: true },
            { key: "token", label: "Access token", secret: true, optional: true },
        ],
        hint: "Loaded by the agent next turn. Re-adding the same name updates it.",
        guide: {
            scopes: "private repos: read access (e.g. GitHub `repo`)",
            steps: [
                "Point at a git repo holding a Claude Code plugin.",
                "Private repo: add a token with read access.",
                "Or browse a marketplace above to pre-fill this form.",
            ],
        },
    },
    {
        id: "extension",
        name: "Extension",
        kind: "extension",
        category: "extend",
        description: "An intentic extension from a git repo.",
        fields: [
            { key: "url", label: "Git URL", placeholder: "https://github.com/owner/extension" },
            // A full sha, not a branch: extension code runs trusted, so installs pin exactly the reviewed commit.
            { key: "ref", label: "Commit sha (full 40 characters)" },
            { key: "path", label: "Subdirectory", optional: true },
            { key: "token", label: "Access token", secret: true, optional: true },
        ],
        guide: {
            scopes: "private repos: read access (e.g. GitHub `repo`)",
            steps: [
                "Point at a repo with an `intentic-extension.json`.",
                "Pin the exact commit sha you reviewed, branches are not accepted.",
                "Reload the app after installing to load its UI.",
            ],
        },
    },
    // One email identity the sandbox acts as online, set up once instead of per platform. The user signs its email
    // provider in once, live; accounts opened through it share that browser. The open-accounts switch is the real
    // consent.
    // The wallet: what lets the agent spend money online. One per sandbox; every field is a limit, not a credential,
    // since the signing key stays with the custody provider. Defaults are conservative: every payment carded, ceilings
    // small.
    {
        id: "wallet",
        name: "Wallet",
        kind: "wallet",
        category: "business",
        icon: "credit-card",
        description: "Let the agent pay per-call APIs in USDC.",
        singleton: true,
        fields: [
            {
                key: "network",
                label: "Network",
                default: "eip155:8453",
                options: [
                    { value: "eip155:8453", label: "Base, real USDC" },
                    { value: "eip155:84532", label: "Base Sepolia, test money" },
                ],
                hint: "Start on test money: the whole flow works with faucet USDC.",
            },
            {
                key: "perPaymentMaxUsd",
                label: "Most per payment (USD)",
                default: "1.00",
                hint: "A hard ceiling: anything dearer is refused outright.",
            },
            {
                key: "dailyCapUsd",
                label: "Most per day (USD)",
                default: "5.00",
                hint: "Resets at midnight UTC.",
            },
            {
                key: "autoApproveUnderUsd",
                label: "Approve automatically under (USD)",
                default: "0",
                hint: "0 = every payment asks you in chat first.",
            },
            {
                key: "allow",
                label: "Auto-approve only these hosts",
                optional: true,
                advanced: true,
                placeholder: "api.example.com, data.example.org",
                hint: "With hosts listed, auto-approval applies only to them.",
            },
            {
                key: "deny",
                label: "Never pay these hosts",
                optional: true,
                advanced: true,
                placeholder: "sketchy.example",
                hint: "Refused whatever the price.",
            },
        ],
        hint: "The key stays with the platform's custody provider: the agent can never move more than your limits allow. Fund it by sending USDC to the address shown once connected.",
    },
    {
        id: "identity",
        name: "Identity",
        kind: "identity",
        category: "communication",
        icon: "user",
        description: "One email, every account grows from it.",
        fields: [
            { key: "email", label: "Email address", placeholder: "you@gmail.com" },
            {
                key: "password",
                label: "Email password",
                secret: true,
                optional: true,
                hint: "Most people leave this empty and sign in themselves.",
            },
            {
                key: "mailbox",
                label: "Code mailbox",
                optional: true,
                advanced: true,
                placeholder: "the IMAP connection's name",
                hint: "A connected IMAP entry: the agent fetches verification codes, never the inbox.",
            },
            {
                key: "loginUrl",
                label: "Sign-in page",
                optional: true,
                advanced: true,
                placeholder: "https://accounts.google.com/",
                hint: "Guessed from the address when empty.",
            },
            {
                key: "openAccounts",
                label: "May open accounts on its own",
                boolean: true,
                default: "off",
                hint: "Automated signup is against many platforms' terms: your call to make.",
            },
            // Set here, not per account: an identity is one browser, so every account born from it shares its country
            // too.
            {
                key: "exit",
                label: "Browse through",
                optional: true,
                advanced: true,
                placeholder: "the geo exit's name",
                hint: "A connected Geo exit: every account under this identity browses from that country.",
            },
        ],
        hint: "You do one email login; the agent signs into everything that grows from it.",
        guide: {
            steps: [
                "A dedicated address beats your personal one.",
                "After adding, open `Log in` and sign into the provider yourself.",
                "Add platform accounts under it, or let the agent open them.",
            ],
        },
    },
    // One card for every model API, local or remote: all are just a URL that serves models, the wire protocol is the
    // only real axis. The placeholder shows the local case, the one people don't expect already works.
    {
        id: "endpoint",
        name: "Model endpoint",
        kind: "endpoint",
        category: "extend",
        icon: "sparkles",
        description: "Your own models, Ollama, vLLM, a gateway.",
        fields: [
            { key: "baseUrl", label: "API base URL", placeholder: "http://host.docker.internal:11434/v1" },
            {
                key: "protocol",
                label: "API",
                default: "openai",
                options: [
                    { value: "openai", label: "OpenAI-compatible" },
                    { value: "anthropic", label: "Anthropic-compatible" },
                ],
            },
            { key: "apiKey", label: "API key", secret: true, optional: true, hint: "Empty is fine: most self-hosted servers have no auth." },
            { key: "headers", label: "Extra headers (Name: value per line)", optional: true, advanced: true, multiline: true },
        ],
        hint: "No server yet? The Local model card runs one inside the sandbox for you.",
        guide: {
            steps: [
                "Note the URL your server's API is on (Ollama: port `11434`).",
                "On THIS machine, that is `http://host.docker.internal:11434/v1`.",
                "Its models appear in the chat's model picker after adding.",
            ],
        },
    },
    // Runs the server inside the sandbox instead of pointing at one; only two real choices (model, window), the rest is
    // the daemon's. Memory is quoted in two parts (weights + cache) since one figure hides the window as a free lever.
    {
        id: "localmodel",
        name: "Local model",
        kind: "localmodel",
        category: "extend",
        icon: "robot",
        description: "A model that runs inside the sandbox: private, free.",
        fields: [
            {
                key: "model",
                label: "Model",
                default: "unsloth/Qwen3.5-9B-GGUF/Qwen3.5-9B-Q4_K_M.gguf",
                // Weights alone; the cache (~1 GB/16k) is priced on the window field below. Add both for the real RAM
                // ask.
                options: [
                    { value: "unsloth/Phi-4-mini-instruct-GGUF/Phi-4-mini-instruct-Q4_K_M.gguf", label: "Phi-4-mini 3.8B, weights ~3 GB" },
                    { value: "unsloth/Qwen3.5-9B-GGUF/Qwen3.5-9B-Q4_K_M.gguf", label: "Qwen3.5 9B, weights ~6 GB" },
                    { value: "unsloth/gemma-4-12b-it-GGUF/gemma-4-12b-it-Q4_K_M.gguf", label: "Gemma 4 12B, weights ~14 GB" },
                    {
                        value: "unsloth/Qwen3.8-27B-GGUF/Qwen3.8-27B-UD-Q4_K_M.gguf",
                        label: "Qwen3.8 27B, weights ~22 GB",
                    },
                    { value: "custom", label: "Custom GGUF (advanced)" },
                ],
                hint: "Downloads once into the workspace, then serves from this sandbox.",
            },
            {
                key: "url",
                label: "GGUF download URL",
                placeholder: "https://huggingface.co/…/resolve/main/model.gguf",
                when: "model == 'custom'",
                hint: "A direct link to a .gguf file.",
            },
            // Used to serve a flat 32k window, under one turn's own cost; it's on the card now since it's the owner's
            // memory to spend. Each rung's price is its cache cost; options and default come from the contract so
            // daemon and card can't drift.
            {
                key: "context",
                label: "Conversation window",
                default: LOCAL_MODEL_WINDOW_DEFAULT,
                options: [
                    ...LOCAL_MODEL_WINDOWS.map((tokens) => ({ value: tokens, label: WINDOW_LABELS[tokens] })),
                    { value: "custom", label: "Custom" },
                ],
                hint: "64k is the smallest that fits a full agent turn.",
            },
            {
                key: "contextTokens",
                label: "Window in tokens",
                placeholder: "98304",
                when: "context == 'custom'",
                hint: "2,048 to 1,048,576, about 1 GB of RAM per 16k.",
            },
            {
                key: "gpu",
                label: "Use this machine's NVIDIA GPU",
                boolean: true,
                default: "off",
                rebuild: true,
                hint: "Needs nvidia-container-toolkit on the host. Off = CPU, fine for the small ones.",
            },
        ],
        hint: "Nothing leaves this machine, and it works offline. Already running Ollama or vLLM? The Model endpoint card points at it instead.",
        guide: {
            steps: [
                "Pick a model and window this machine has the free RAM for, the sum is computed under the form.",
                "It downloads and serves right away; only the GPU switch asks for a rebuild.",
                "Short of memory? A 16k window pinned as the quick model makes commit messages free.",
            ],
        },
    },
];

const isCapabilityCategory = (category: string): category is CapabilityCategory => CAPABILITY_CATEGORIES.some((entry) => entry.id === category);

// Fields the core contributes instead of the card declaring them, so no card can weaken them: device switches (grant
// doesn't vary by OS) and browser credentials (same login fact everywhere, needed for the agent to sign in).
const BROWSER_CREDENTIAL_FIELDS: readonly CapabilityField[] = [
    // Folded behind "Let the agent sign in for you": the primary flow is adding, then signing in yourself.
    { key: "username", label: "Username / email", optional: true, advanced: true },
    { key: "password", label: "Password", secret: true, optional: true, advanced: true },
    // Which identity this account is born from; no `options`, the web narrows it to identities that exist.
    {
        key: "identity",
        label: "Belongs to identity",
        optional: true,
        hint: "Shares that identity's browser, so 'Continue with' its provider is one click.",
    },
    // Shown only for an account with its own profile; one under an identity shares that identity's exit instead.
    {
        key: "exit",
        label: "Browse through",
        optional: true,
        advanced: true,
        when: "!identity",
        placeholder: "the geo exit's name",
        hint: "A connected Geo exit: this account then browses from that country.",
    },
];
const CORE_FIELDS: Partial<Record<CapabilityKind, readonly CapabilityField[]>> = { host: HOST_SCOPE_FIELDS, browser: BROWSER_CREDENTIAL_FIELDS };

// A contribution rendered as a catalog card; the manifest is the single source of name/logo/fields/guide. The
// contribution's id becomes the card id and the pinned discriminator; an unknown category lands under "extend".
export const contributionCard = (contribution: CapabilityContribution): CapabilityCatalogEntry => {
    const discriminator = contributionDiscriminator(contribution.kind);
    return {
        id: contribution.id,
        name: contribution.catalog.name,
        kind: contribution.kind,
        category: isCapabilityCategory(contribution.catalog.category) ? contribution.catalog.category : "extend",
        logo: contribution.catalog.logo,
        icon: contribution.catalog.icon,
        description: contribution.catalog.description,
        fields: [
            ...(discriminator === undefined ? [] : [{ key: discriminator, label: "", value: contribution.id }]),
            ...contribution.fields,
            // A card declaring a core key keeps its own version; a duplicate key would render the input twice.
            ...(CORE_FIELDS[contribution.kind] ?? []).filter((core) => !contribution.fields.some((field) => field.key === core.key)),
        ],
        hint: contribution.catalog.hint,
        guide: contribution.catalog.guide,
    };
};

// The join between a card and its live connections, shared by the grid and the daemon's ask gate. A discriminator field
// (`provider`, `platform`) tells same-`kind` cards apart; none means every instance matches.

// The structural slice of a live connection the join reads; both the daemon's `Capability` and the wire's
// `CapabilitySummary` satisfy it. `undefined` is admitted since per-kind config shapes carry optional fields.
export interface CapabilityInstanceLike {
    readonly kind: string;
    readonly config: Record<string, string | number | boolean | undefined>;
}

const cardDiscriminator = (entry: CapabilityCatalogEntry): { key: string; values: string[] } | undefined => {
    const field = entry.fields.find((candidate) => candidate.key === "provider" || candidate.key === "platform");
    if (field === undefined) {
        return undefined;
    }
    return { key: field.key, values: field.value !== undefined ? [field.value] : (field.options ?? []).map((option) => option.value) };
};

// The live connections a card is answerable for.
export const instancesOf = <T extends CapabilityInstanceLike>(entry: CapabilityCatalogEntry, capabilities: readonly T[]): T[] => {
    const disc = cardDiscriminator(entry);
    if (disc === undefined) {
        return capabilities.filter((capability) => capability.kind === entry.kind);
    }
    return capabilities.filter((capability) => capability.kind === entry.kind && disc.values.includes(String(capability.config[disc.key])));
};
