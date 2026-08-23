// Platform UI/product catalogs: the add-form descriptors + card data the web renders. NOT wire contract,
// moved out of @intentic-app/api-contract so the contract holds only schemas. Daemon enums are imported.
import { type CapabilityContribution, type CapabilityField, contributionDiscriminator } from "@intentic/extension-manifest";
import { type CapabilityKind, type ExitPoint, type ServiceKind, TOR_EXIT_COUNTRIES, VPNGATE_EXIT_COUNTRIES } from "@intentic/sandbox-contract";

/* One country in the geo-exit card's picker. The capacity share rides in the LABEL rather than being dropped,
 * because a bare country list is misleading here: a third of Tor's countries are one overloaded relay, and
 * picking one of those looks like a broken exit rather than a thin one. Seeing "30% of capacity" next to the
 * Netherlands and "0.2%" next to the United Kingdom is what makes the menu honest. */
const countryOption = (point: ExitPoint): { value: string; label: string } => ({
    value: point.country,
    label: `${point.countryName}${point.share === undefined ? "" : ` — ${point.share >= 0.01 ? Math.round(point.share * 100) : "<1"}% of capacity`}`,
});

// Catalog the web uses to render the add forms. Only the user-provided, non-secret fields appear here.
// Backends are never added through a bare form: servers register themselves via the connect-host command
// (ConnectHost), Cloudflare through the CloudflareConnect step.
export interface InventoryFieldDescriptor {
    readonly key: string;
    readonly label: string;
    readonly kind: "text" | "number";
}
// The self-hosted service catalog the infra operator panel's "Add service" dialog renders: one card per deployable service
// (logo is a simple-icons slug, like CapabilityCatalogEntry.logo), then the per-service fields form.
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
        // No infisical slug in simple-icons, render the semantic lock glyph instead.
        service: "infisical",
        label: "Infisical",
        icon: "lock",
        description: "Secrets management for apps and teams.",
        fields: [{ key: "domain", label: "Domain", kind: "text" }],
    },
];

// POST /capabilities body: id + kind + kind-specific config (built from the catalog form; the daemon validates
// the discriminated shape). Values are the form's strings; empty optional fields are omitted by the dialog.
export interface AddCapabilityInput {
    readonly id: string;
    readonly kind: CapabilityKind;
    readonly config: Record<string, string>;
}

/* The form field shape is `CapabilityField` from @intentic/extension-api. ONE definition for the fields a
 * static card authors here and the fields an extension declares in its manifest, because the dialog renders
 * them with the same code and a second copy is a second thing to keep in step. `secret` withholds the value
 * from every echo, `value` pins a field the user never sees (a discriminator), `when` gates one field on the
 * answers already given (a condition string, see @intentic/base/when), and `multiline` matters: a single-line
 * input strips the newlines out of a pasted PEM key. */

// The logical section a card sits under in the "+" grid, a display grouping (by what it's for), not the
// technical `kind`. `platform` cards unlock a new workspace area; the rest are connectors to existing tools.
export type CapabilityCategory =
    "platform" | "code" | "observability" | "data" | "communication" | "business" | "machines" | "servers" | "deploy" | "extend";

// The grid's sections, in render order, with their headers. Cards are grouped by `category` under these.
export const CAPABILITY_CATEGORIES: readonly { readonly id: CapabilityCategory; readonly label: string; readonly hint: string }[] = [
    { id: "platform", label: "Platform", hint: "Scaffold managed repos that appear as their own operator panels." },
    { id: "code", label: "Code & issues", hint: "Repos, issues and pipelines as agent tools." },
    { id: "observability", label: "Observability", hint: "Query errors, traces, logs and metrics." },
    { id: "data", label: "Data", hint: "Let the agent query your SQL databases." },
    { id: "communication", label: "Communication", hint: "Let the agent read and send messages." },
    { id: "business", label: "Business & docs", hint: "Connect payments and knowledge bases." },
    // Distinct from Servers on purpose: a server is something the sandbox DIALS, a computer of yours is
    // something that dials the sandbox, and the difference the user feels is that one of them is the machine
    // they are sitting at.
    { id: "machines", label: "Your computers", hint: "Let the agent work on your own computer, run commands, handle files, see the screen." },
    { id: "servers", label: "Servers", hint: "Give the agent remote machines over SSH and private networks over VPN." },
    { id: "deploy", label: "Deploy & infra", hint: "Drive your container deployments, stacks, services and releases." },
    { id: "extend", label: "Extend", hint: "Add any MCP server or Claude Code plugin." },
];

// How to obtain the credential a card needs, surfaced beside the config form as a permanently open panel: the
// required-scopes line, the step-by-step, and a deep "Create a token ↗" link. A hosted provider uses an
// absolute `url`; a self-hostable one builds the link from a config field's live value (`urlFromField` +
// `path`), so it points at github.com or the user's own instance, and simply hides until that field holds an
// http(s) URL.
//
// WRAP LITERALS IN `BACKTICKS` in `scopes` and `steps`, a scope name, a menu item, a hostname, a port, a
// command. They render as chips, which is what lets a reader pick the value out of the sentence instead of
// parsing it. Nothing else is markup, and unmatched backticks stay as typed.
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

/* A kind's user-facing story is this package: the cards below declare what a user picks and fills in, and
 * effects.ts declares what adding it does to their sandbox. Re-exported here so consumers import one module. */
export * from "./effects.js";

// The grid the rail's "+" renders. Every card is a capability *type*; the user names each instance (→ its id,
// defaulted to `id`), so a provider can have N instances (two Discord bots, two databases). `requires` cards are
// shown but gated until the prereq is active.
export interface CapabilityCatalogEntry {
    readonly id: string;
    readonly name: string;
    readonly kind: CapabilityKind;
    readonly category: CapabilityCategory;
    // A simple-icons slug (https://cdn.simpleicons.org/<logo>). A "/<hex>" suffix forces a color for icons
    // invisible on the dark canvas (e.g. github's near-black). Undefined → the `icon` glyph, else per-kind.
    readonly logo?: string | undefined;
    // An @intentic/ui IconName rendered when no simple-icons `logo` fits the brand (before the per-kind
    // fallback). undefined → the generic per-kind icon.
    readonly icon?: string | undefined;
    // ONE LINE: 60 characters or fewer. Three or four tiles sit across the grid and a row is as tall as its
    // tallest one, so a second clause here costs height on the cards beside it too. The grid clamps it at two
    // lines regardless. Anything longer belongs in `hint`.
    readonly description: string;
    readonly requires?: readonly CapabilityKind[] | undefined;
    readonly fields: readonly CapabilityField[];
    // The paragraph, printed under the add-form, and searched from the catalog, so a card stays findable by
    // words its one-line description no longer has room for.
    readonly hint?: string | undefined;
    readonly guide?: CapabilityGuide | undefined;
    /* ONE PER SANDBOX, there is nothing to name and nothing to have two of (the Docker Engine is the machine's
     * engine; a second entry would just be a second opinion about the same dockerd). Such a card drops the name
     * field, keeps the entry id, and opens PRE-FILLED FROM THE LIVE INSTANCE, so picking it again is editing
     * what is there rather than adding beside it.
     *
     * Without this the default "add another connection" behaviour, right for two Discord bots, two databases,
     * turns the obvious way to change an option into minting `docker-2`: two entries, two fragments, both baked
     * into one overlay, and a GPU switch that reads off on the card the user just set to on. */
    readonly singleton?: boolean | undefined;
}

// The permission switches every connected-computer card carries, identical across platforms, the grant is about
// what the agent may DO, which does not vary by OS. Shared so the two cards can't drift into different defaults.
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
        label: "Manage sandboxes on this computer",
        default: "off",
        options: [
            { value: "off", label: "Blocked" },
            { value: "on", label: "Allowed" },
        ],
        hint: "Start, stop, restart and update the Intentic sandboxes running on this machine, narrower than Run commands, and enough to delegate the machine's sandbox fleet to this one.",
    },
    {
        key: "sandboxRemove",
        label: "Remove sandboxes from this computer",
        default: "off",
        options: [
            { value: "off", label: "Blocked" },
            { value: "on", label: "Allowed" },
        ],
        hint: "Delete a sandbox on this machine along with its files and its history. Separate from managing them because nothing undoes it.",
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
        /* The engine itself takes no configuring; these are the things a user chooses about it, in the two
         * families DockerConfigSchema defines, and the `rebuild` chip is what tells them apart on sight,
         * because the first costs a rebuild and the rest cost a dockerd restart.
         *
         * `--privileged` is deliberately NOT a field: dockerd does not run without it, so a switch would offer
         * a broken sandbox as an option. It stays disclosed by the effects panel and the hint below. */
        fields: [
            {
                key: "gpu",
                label: "GPU access",
                boolean: true,
                default: "off",
                rebuild: true,
                hint: "Passes the host's NVIDIA GPUs into the engine, for CUDA images and GPU compose stacks. Needs an NVIDIA GPU and nvidia-container-toolkit on the host, checked at rebuild, and the sandbox still starts without GPUs if it can't.",
            },
            {
                key: "registryMirror",
                label: "Registry mirror",
                optional: true,
                placeholder: "https://registry.example.internal",
                hint: "A pull-through cache for Docker Hub, worth setting on a slow, metered or air-gapped link, since this engine starts with an empty image store.",
            },
            {
                key: "insecureRegistries",
                label: "Insecure registries",
                optional: true,
                placeholder: "registry.lan:5000",
                hint: "Registries reachable over plain http or with a self-signed certificate. Space- or comma-separated.",
            },
            {
                key: "addressPool",
                label: "Container address pool",
                optional: true,
                placeholder: "10.201.0.0/16",
                hint: "The subnet this engine carves container networks from. Change it when Docker's default (172.17.0.0/16) collides with your VPN or LAN, the symptom is internal hosts going unreachable while everything else works.",
            },
        ],
        hint: "One-time rebuild required, the sandbox restarts privileged with its own isolated Docker Engine (your machine's Docker is never shared).",
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
                "Use a dedicated key or account scoped to what the agent should reach.",
                "Generate one: `ssh-keygen -t ed25519 -f agent_key`, then add `agent_key.pub` to the server's `authorized_keys`.",
                "Paste the unencrypted private key here.",
                "Or switch `Authentication` to `Password` and paste the password instead.",
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
            // The discriminator: every field below is gated on it, so one card serves all three protocols and
            // the daemon receives exactly one arm of the config union.
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
                placeholder: "only if your gateway uses one",
                when: "provider == 'fortinet'",
            },
            {
                key: "trustedCert",
                label: "Trusted certificate",
                optional: true,
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
            {
                key: "ikeVersion",
                label: "IKE version",
                default: "1",
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
                options: [
                    { value: "on", label: "On" },
                    { value: "off", label: "Off" },
                ],
                when: "provider == 'ipsec'",
            },
            // The split-vs-full tunnel decision, and the one ipsec setting whose wrong value has no symptom the
            // user can attribute: a gateway that doesn't route the internet accepts 0.0.0.0/0 and then drops
            // everything else, so the sandbox, the agent's own connection included, goes quiet. Which is why
            // the hint states the consequence rather than the syntax.
            {
                key: "routedNetworks",
                label: "Routed networks",
                default: "0.0.0.0/0",
                placeholder: "10.0.0.0/8,192.168.0.0/16",
                hint: "Which networks go through the tunnel. 0.0.0.0/0 sends everything, including this sandbox's own internet access, if the gateway doesn't route the internet, list only the networks behind it.",
                when: "provider == 'ipsec'",
            },

            // Shared: the only persisted connection intent. Connecting itself is a live action on the Status card.
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
        hint: "Connect and disconnect from Sandbox ▸ Status (the agent can too). Auto-connect re-dials after a sandbox restart.",
        guide: {
            steps: [
                "WireGuard: paste the full `.conf` (`[Interface]` + `[Peer]`) from your provider or server.",
                "FortiGate SSL-VPN: use the gateway host and port your FortiClient connection uses (e.g. `vpn.example.com:10443` → host + `10443`).",
                "IPsec: the pre-shared key, plus your XAuth username and password if the gateway asks for them.",
                "IPsec routed networks: keep `0.0.0.0/0` only if the gateway also carries your internet, otherwise list the networks behind it, or the sandbox loses everything the gateway doesn't route.",
                "Have a FortiClient config file? Use `Import from FortiClient` above to fill this in from it.",
                "If the gateway asks for a 2FA code, connect from the `Status` card and enter the code there.",
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
            /* The discriminator, ordered by what it costs the reader. Tor first because it is the one that
             * needs no account, no credentials and no container privilege at all; the paste-your-own arm last
             * because it is the only one that asks for anything. */
            {
                key: "provider",
                label: "Provider",
                default: "tor",
                hint: "Tor is free, needs no account and reaches the most countries. VPN Gate is free too but is mostly Japan and Korea. Paste your own for a provider you already have (Proton VPN's free tier, Mullvad).",
                options: [
                    { value: "tor", label: "Tor (free, ~28 countries)" },
                    { value: "vpngate", label: "VPN Gate (free, Japan/Korea)" },
                    { value: "wireguard", label: "Paste WireGuard configs" },
                ],
            },
            /* THE COUNTRY IS A PICKER, NOT A TEXT BOX, and per provider, because that is the whole "known
             * addresses are filled in for you" half of this card. The lists are the measured capacity tables
             * from the contract, sorted best-supplied first, so the top of each menu is the part that works
             * and nobody types a code that turns out to have one overloaded relay behind it. Servers are
             * never asked for at all: the driver picks one out of the provider's live catalog. */
            {
                key: "country",
                label: "Come out in",
                optional: true,
                default: "",
                hint: "Leave on Anywhere unless a task needs a specific country: it is faster and, on Tor, kinder to a volunteer network. You can switch country any time afterwards without re-adding this.",
                when: "provider == 'tor'",
                options: [{ value: "", label: "Anywhere (fastest)" }, ...TOR_EXIT_COUNTRIES.map(countryOption)],
            },
            {
                key: "country",
                label: "Come out in",
                optional: true,
                default: "",
                hint: "VPN Gate's pool is overwhelmingly Japanese and Korean. For anywhere else, add a Tor exit instead.",
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
                hint: "Paste one file per country, back to back. The country is read from each file automatically; add a `# country: DE` line to any it cannot place.",
                when: "provider == 'wireguard'",
            },
            {
                key: "country",
                label: "Start in",
                optional: true,
                placeholder: "DE",
                hint: "Two-letter code, matching one of the files pasted above. Leave empty to use the first one.",
                when: "provider == 'wireguard'",
            },
            /* Off by default, the opposite of the VPN card's auto-connect, and deliberately. A VPN is dialled
             * because something behind it is unreachable otherwise; an exit costs volunteer bandwidth and buys
             * nothing until a task actually wants another country. A browser account bound to this exit starts
             * it on demand anyway, so "on" is for an exit something long-running depends on. */
            {
                key: "autoStart",
                label: "Start automatically",
                default: "off",
                hint: "Off means it comes up when something asks for it. On means it is held up from the moment the sandbox starts.",
                options: [
                    { value: "off", label: "Off" },
                    { value: "on", label: "On" },
                ],
            },
        ],
        hint: "Nothing goes through an exit unless you point it there: this never changes the sandbox's own connection. Bind a browser account to it on that account's card, or use `geo proxy <name>` with curl.",
        guide: {
            steps: [
                "Tor: nothing to fill in. Pick a country and add it, that is the whole setup.",
                "VPN Gate: nothing to fill in either. Its server list is fetched for you and a server is picked per country.",
                "Proton VPN (free): sign in at `account.protonvpn.com` → `Downloads` → `WireGuard configuration`, generate one config per free country, and paste the files here one after another.",
                "Mullvad: `mullvad.net/account` → `WireGuard configuration`, pick the countries you want, paste the files here.",
                "Any other provider: any standard `.conf` works. Several files in this one box is the point, they become one pool you switch between.",
                "After adding, switch country from the `Status` card or with `geo use <name> DE` (the command is `geo`, since `exit` is a shell builtin). Every switch is verified against the real address and fails if it lands in the wrong country.",
                "These are datacenter addresses: sites that check will see a proxy. Nothing free looks like an ordinary home connection.",
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
            steps: [
                "Get your remote MCP server's URL (a Streamable HTTP or SSE endpoint).",
                "If it needs auth, paste a bearer token (optional).",
                "The agent connects to it next turn.",
            ],
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
                "Point at a git repo that holds a Claude Code plugin (skills, agents, hooks, MCP).",
                "Private repo: add a token with read access.",
                "Optionally set a branch/tag and a subdirectory.",
                "Or browse a marketplace above to pre-fill the form.",
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
            // A full sha, not a branch: extension code runs trusted in your browser, so installs pin exactly
            // the reviewed commit, updating is re-adding at a new sha.
            { key: "ref", label: "Commit sha (full 40 characters)" },
            { key: "path", label: "Subdirectory", optional: true },
            { key: "token", label: "Access token", secret: true, optional: true },
        ],
        guide: {
            scopes: "private repos: read access (e.g. GitHub `repo`)",
            steps: [
                "Point at a git repo with an `intentic-extension.json` at its root (or the subdirectory).",
                "Pin the exact commit sha you reviewed: branches and tags are not accepted.",
                "Private repo: add a token with read access.",
                "Reload the app after installing to load its UI; agent contributions load next turn.",
            ],
        },
    },
    /* ONE EMAIL IDENTITY THE SANDBOX ACTS AS ONLINE, the setup question asked once instead of twelve times.
     * The identity owns a browser; you sign its email provider in yourself, once, in the live window (Google
     * blocks automated logins, that one step staying human is what makes everything after it work), and the
     * platform accounts opened through it share that browser, which is what turns "Continue with Google" into
     * one click. The open-accounts switch is the consent that matters, so it is a field here with the warning
     * on its face, off by default, per identity, never global. */
    /* THE WALLET, the agent's ability to buy things on the open web, and the card that bounds it.
     *
     * One per sandbox (there is one owner and one balance; a second entry would be a second opinion about
     * the same money), and every field on it is a LIMIT rather than a credential: the signing key lives with
     * the platform's custody provider and never enters the container, so what the owner is deciding here is
     * exactly how much of their money an agent may move and how often it has to ask. Defaults are the
     * conservative ones, every payment carded, small ceilings, because the safe posture must be the one a
     * user gets by clicking through. */
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
                hint: "Start on test money: the whole flow, approval cards, budgets, receipts, works identically with faucet USDC and costs nothing.",
            },
            {
                key: "perPaymentMaxUsd",
                label: "Most per payment (USD)",
                default: "1.00",
                hint: "A hard ceiling. Anything dearer is refused outright, the agent cannot even ask.",
            },
            {
                key: "dailyCapUsd",
                label: "Most per day (USD)",
                default: "5.00",
                hint: "Across every payment, carded or not. Resets at midnight UTC.",
            },
            {
                key: "autoApproveUnderUsd",
                label: "Approve automatically under (USD)",
                default: "0",
                hint: "Leave at 0 and every single payment asks you in chat first. Raise it to let small payments through without interrupting you, they still count against the daily cap.",
            },
            {
                key: "allow",
                label: "Auto-approve only these hosts",
                optional: true,
                placeholder: "api.example.com, data.example.org",
                hint: "Optional. With hosts listed, automatic approval applies only to them; everything else still asks. Ignored when automatic approval is off.",
            },
            {
                key: "deny",
                label: "Never pay these hosts",
                optional: true,
                placeholder: "sketchy.example",
                hint: "Refused before any card goes up, whatever the price.",
            },
        ],
        hint: "Your sandbox gets its own USDC wallet, held by the platform's custody provider, the agent never sees a key and cannot move money without your limits allowing it. Fund it by sending USDC to the address shown on the card after it connects, then the agent can pay any endpoint that charges per call over the x402 protocol. Every payment is receipted with its on-chain transaction.",
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
                hint: "Only so the agent can have it re-typed into the provider's own login, most people leave this empty and sign in themselves.",
            },
            {
                key: "mailbox",
                label: "Code mailbox",
                optional: true,
                placeholder: "the IMAP connection's name",
                hint: "A connected IMAP entry for this address. The agent then asks for 'the newest code from this site' and gets exactly that, never the inbox.",
            },
            {
                key: "loginUrl",
                label: "Sign-in page",
                optional: true,
                placeholder: "https://accounts.google.com/",
                hint: "Guessed from the address when empty.",
            },
            {
                key: "openAccounts",
                label: "May open accounts on its own",
                boolean: true,
                default: "off",
                hint: "Lets the agent create new platform accounts through this identity when a task needs one. Automated signup is against many platforms' terms, leave off unless that is a call you have made.",
            },
            /* WHERE THIS IDENTITY LIVES. Set here rather than on each account because an identity IS one
             * browser: every account born from it shares the profile, so they share the country too. One
             * signed-in session appearing from two places at once is a much louder signal than any address,
             * and this card is the only place that can be decided coherently. */
            {
                key: "exit",
                label: "Browse through",
                optional: true,
                placeholder: "the geo exit's name",
                hint: "A connected Geo exit. Every account under this identity then browses from that country, with its clock and language set to match. Leave empty to browse from this sandbox's own connection.",
            },
        ],
        hint: "The agent signs into (and opens) platform accounts through this identity's browser, you do one login, it does the rest, and calls you in for anything only a person can clear.",
        guide: {
            steps: [
                "Name it and give it the email address it IS: a dedicated address beats your personal one.",
                "After adding, open `Log in` and sign into the email provider yourself in the live window.",
                "Optionally connect `IMAP` for the same address and name it under `Code mailbox`, so the agent can fetch verification codes itself.",
                "Add platform accounts under this identity (or turn on `May open accounts` and let the agent open them as work needs them).",
            ],
        },
    },
    /* ONE CARD FOR EVERY MODEL API, wherever it runs. An Ollama on this machine, a vLLM on the GPU box, a
     * LiteLLM gateway and OpenRouter are the same thing, a URL that serves models, and the only axis that
     * actually changes anything is which wire the server speaks. Splitting it into "local" and "remote" cards
     * would be two forms, two sets of copy and two ways to be wrong about one concept; the placeholder carries
     * the local case instead, because that is the one people don't realise already works. */
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
            { key: "apiKey", label: "API key", secret: true, optional: true },
            { key: "headers", label: "Extra headers (Name: value per line)", optional: true, multiline: true },
        ],
        hint: "A server on this machine is reachable at host.docker.internal, the sandbox always resolves it. Models are read from the endpoint itself, so pulling a new one just needs a reload. Most servers are OpenAI-compatible; pick Anthropic only if it serves /v1/messages. No server yet? The Local model card runs one inside the sandbox for you.",
        guide: {
            steps: [
                "Start your model server and note the URL its API is on (Ollama: `http://localhost:11434/v1`).",
                "Running on THIS machine? Use `host.docker.internal` in place of `localhost`: the sandbox is a container.",
                "Leave the key empty if the server has no auth; most self-hosted ones don't.",
                "Its models then appear as their own provider in the chat's model picker.",
            ],
        },
    },
    /* THE MANAGED HALF of the concept above: the endpoint card points at a server the user operates, this one
     * runs the server inside the sandbox. One decision (which weights) and everything else is the daemon's:
     * the download, the loopback llama-server, the provider registration. The GPU switch is the single field
     * that costs a rebuild, and it wears the chip that says so; on the published image everything else is
     * add-and-chat. Model options carry Hugging Face paths so shipping a new recommendation is an edit here,
     * never a daemon release, and the labels state the real cost (free memory) because that is the one fact a
     * person needs before choosing. */
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
                /* THE RAM FIGURES ARE WEIGHTS PLUS CACHE, NOT WEIGHTS. The cache the server needs for the
                 * conversation is not a rounding error next to the weights: it is sized by the context window,
                 * and the daemon caps that window and quantizes the cache precisely so these numbers can stay
                 * in the shape a person can check against their own machine (see the CONTEXT_TOKENS comment in
                 * handlers/localmodel.ts, which is where the arithmetic lives). Change the cap there and these
                 * labels are wrong; the two belong to each other. */
                options: [
                    { value: "unsloth/Phi-4-mini-instruct-GGUF/Phi-4-mini-instruct-Q4_K_M.gguf", label: "Phi-4-mini 3.8B, needs ~5 GB free RAM" },
                    { value: "unsloth/Qwen3.5-9B-GGUF/Qwen3.5-9B-Q4_K_M.gguf", label: "Qwen3.5 9B, needs ~8 GB free RAM" },
                    { value: "unsloth/gemma-4-12b-it-GGUF/gemma-4-12b-it-Q4_K_M.gguf", label: "Gemma 4 12B, needs ~16 GB free RAM" },
                    {
                        value: "unsloth/Qwen3.8-27B-GGUF/Qwen3.8-27B-UD-Q4_K_M.gguf",
                        label: "Qwen3.8 27B, needs ~24 GB free RAM",
                    },
                    { value: "custom", label: "Custom GGUF (advanced)" },
                ],
                hint: "Downloads once into the workspace (gigabytes, kept across rebuilds), then serves from this sandbox with a 32k-token conversation window.",
            },
            {
                key: "url",
                label: "GGUF download URL",
                placeholder: "https://huggingface.co/…/resolve/main/model.gguf",
                when: "model == 'custom'",
                hint: "A direct link to a .gguf file. You are choosing the memory it needs.",
            },
            {
                key: "gpu",
                label: "Use this machine's NVIDIA GPU",
                boolean: true,
                default: "off",
                rebuild: true,
                hint: "Needs nvidia-container-toolkit on the host. Off, the model runs on CPU, fine for the small ones.",
            },
        ],
        hint: "Nothing leaves this machine: the sandbox downloads the model and serves it itself: no server to install, works offline. Small models won't replace your frontier chat model; they shine as the quick model (free commit messages) and for work that must stay local. Already running Ollama or vLLM? The Model endpoint card points at it instead.",
        guide: {
            steps: [
                "Pick a model whose memory need fits this machine, the label says it.",
                "On the standard image it downloads and serves right away; only the GPU switch asks for a rebuild.",
                "It then appears as its own provider in the chat's model picker.",
                "Optionally pin it as the quick model in Settings, and commit messages and titles then cost nothing.",
            ],
        },
    },
];

const isCapabilityCategory = (category: string): category is CapabilityCategory => CAPABILITY_CATEGORIES.some((entry) => entry.id === category);

/* Fields the CORE contributes to a kind's form rather than the card declaring them. The connected-computer
 * switches are the whole example, and they are here rather than in the manifest on purpose: the grant is about
 * what the agent may DO, which does not vary by OS, so a card that could restate them is a card that could
 * quietly weaken them. Two platform packs therefore cannot drift, and neither can a third-party one.
 *
 * The browser credentials are core for the sibling reason: which box a login form wants filled is the same
 * fact on every site, and they are what lets the AGENT connect the account itself, the daemon types the
 * stored values into the page (never showing the agent the password), so a site card that forgot to declare
 * them would be a site the agent cannot sign in to. Both optional: a profile signed in by hand needs neither. */
const BROWSER_CREDENTIAL_FIELDS: readonly CapabilityField[] = [
    { key: "username", label: "Username / email", optional: true },
    { key: "password", label: "Password", secret: true, optional: true },
    /* Which identity this account is born from, core for the same reason the credentials are: whose browser an
     * account lives in is a fact about the sandbox, not about any site, and it is what makes "Continue with
     * Google" one click (the identity's session is right there in the shared profile). Declared without
     * `options`; the web narrows it to a picker over the identities that actually exist and hides it when none
     * do, so the manifest stays ignorant of instance state. */
    {
        key: "identity",
        label: "Belongs to identity",
        optional: true,
        hint: "The identity whose browser this account lives in. It shares its email session, so 'Continue with' its provider is one click.",
    },
    /* WHERE THIS ACCOUNT BROWSES FROM, core for the same reason again: which country a session appears to come
     * from is a fact about the sandbox's manifest, not about any site, so a site card cannot be allowed to
     * forget it or to mean something different by it.
     *
     * Only shown for an account that owns its OWN profile. An account belonging to an identity browses from
     * that identity's exit, because it browses in that identity's Chromium profile: the cookies are shared, so
     * the country has to be. One signed-in session appearing from two countries is a much louder signal than a
     * datacenter address, and the `when` here is what stops the form offering that mistake. */
    {
        key: "exit",
        label: "Browse through",
        optional: true,
        when: "!identity",
        placeholder: "the geo exit's name",
        hint: "A connected Geo exit. Every page this account opens then comes out of that country, with the browser's clock and language set to match. Leave empty to browse from this sandbox's own connection.",
    },
];
const CORE_FIELDS: Partial<Record<CapabilityKind, readonly CapabilityField[]>> = { host: HOST_SCOPE_FIELDS, browser: BROWSER_CREDENTIAL_FIELDS };

/* A contributed capability rendered as a catalog card, the "+" grid derives one card per entry from the
 * ENABLED installed extensions (GET /extensions), so a card exists iff its capability is actually addable, and
 * the manifest is the single source of the card's name/logo/fields/guide (no static duplicate to drift). The
 * contribution's id becomes both the card id (the /capabilities/<id> slug) and the pinned discriminator the
 * daemon's handler resolves. A third-party entry declaring a category outside CAPABILITY_CATEGORIES lands under
 * "extend" (the catch-all section). */
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
            // A card that declares one of the core keys itself keeps its own version, a duplicate key would
            // render the same input twice and let the two answers race for one config slot.
            ...(CORE_FIELDS[contribution.kind] ?? []).filter((core) => !contribution.fields.some((field) => field.key === core.key)),
        ],
        hint: contribution.catalog.hint,
        guide: contribution.catalog.guide,
    };
};

/* THE JOIN BETWEEN A CARD AND THE CONNECTIONS THAT CAME FROM IT, here rather than in the web because both
 * sides ask it: the Capabilities grid joins each card to the live instances it is answerable for, and the
 * daemon's capability ask gate joins the card an agent requested to whatever is already connected. One
 * definition, or the two joins drift on exactly the multi-provider cards the discriminator exists for.
 *
 * Cards that share a `kind` are told apart by a discriminator field the card fixes, `provider` for the cli
 * cards, `platform` for the browser cards (both map straight to the capability's config). The value is a
 * single fixed value, or the options for a multi-provider card (the SQL card owns postgres + mysql).
 * Single-card kinds (mcp/plugin/ssh/…) have no such field → undefined → every instance of the kind matches. */

// The structural slice of a live connection the join reads, the daemon's manifest `Capability` and the
// wire's `CapabilitySummary` both carry it, so one signature serves both sides. `undefined` is admitted in
// the values because the manifest's per-kind config shapes carry optional fields, and the join only ever
// reads the discriminator key.
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

// Automation "start from" recipes moved to the automations extension (@intentic/ext-automations): they are
// automation-UI prefill data, so they live with that extension rather than the platform product catalog.
