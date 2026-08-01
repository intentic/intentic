// Platform UI/product catalogs: the add-form descriptors + card data the web renders. NOT wire contract —
// moved out of @intentic-app/api-contract so the contract holds only schemas. Daemon enums are imported.
import type { ConnectorContribution } from "@intentic/extension-api";
import type { CapabilityKind, ServiceKind } from "@intentic/sandbox-contract";

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
    // An @intentic-app/ui IconName fallback glyph, rendered when no simple-icons `logo` fits the brand.
    readonly icon?: string | undefined;
    readonly description: string;
    readonly fields: readonly InventoryFieldDescriptor[];
}
export const INVENTORY_SERVICES: readonly InventoryServiceDescriptor[] = [
    {
        service: "signoz",
        label: "SigNoz",
        icon: "wave-pulse",
        description: "Observability — traces, logs and metrics.",
        fields: [{ key: "domain", label: "Domain", kind: "text" }],
    },
    {
        service: "outline",
        label: "Outline",
        logo: "outline/f5f5f5",
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
        // No infisical slug in simple-icons — render the semantic lock glyph instead.
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

// One field the "+" dialog renders for a capability's config form. Optional members carry `| undefined` so a
// zod-inferred ConnectorField (exactOptionalPropertyTypes) is assignable — connectorCard passes them through.
export interface CapabilityField {
    readonly key: string;
    readonly label: string;
    readonly placeholder?: string | undefined;
    readonly secret?: boolean | undefined;
    readonly optional?: boolean | undefined;
    // Render a multi-line <textarea> instead of a single-line <input> — a single-line input strips the newlines
    // when a multi-line value (e.g. a PEM private key) is pasted, corrupting it.
    readonly multiline?: boolean | undefined;
    // A fixed value baked into config, not shown as an input — e.g. platform="reddit", provider="stripe".
    readonly value?: string | undefined;
    // A pre-filled default the user can edit (e.g. the "self"/"cf" bindings DevOps registers).
    readonly default?: string | undefined;
    // A user-chosen value from a fixed set — rendered as a Segmented selector instead of a text input.
    readonly options?: readonly { readonly value: string; readonly label: string }[] | undefined;
    // Show/require/send this field only when another field currently equals a value (e.g. the SSH credential
    // that matches the chosen auth mode). Omitted → always shown.
    readonly when?: { readonly key: string; readonly value: string } | undefined;
}

// The logical section a card sits under in the "+" grid — a display grouping (by what it's for), not the
// technical `kind`. `platform` cards unlock a new workspace area; the rest are connectors to existing tools.
export type CapabilityCategory = "platform" | "code" | "observability" | "data" | "communication" | "business" | "servers" | "deploy" | "extend";

// The grid's sections, in render order, with their headers. Cards are grouped by `category` under these.
export const CAPABILITY_CATEGORIES: readonly { readonly id: CapabilityCategory; readonly label: string; readonly hint: string }[] = [
    { id: "platform", label: "Platform", hint: "Scaffold managed repos that appear as their own operator panels." },
    { id: "code", label: "Code & issues", hint: "Repos, issues and pipelines as agent tools." },
    { id: "observability", label: "Observability", hint: "Query errors, traces, logs and metrics." },
    { id: "data", label: "Data", hint: "Let the agent query your SQL databases." },
    { id: "communication", label: "Communication", hint: "Let the agent read and send messages." },
    { id: "business", label: "Business & docs", hint: "Connect payments and knowledge bases." },
    { id: "servers", label: "Servers", hint: "Give the agent remote machines over SSH and private networks over VPN." },
    { id: "deploy", label: "Deploy & infra", hint: "Drive your container deployments — stacks, services and releases." },
    { id: "extend", label: "Extend", hint: "Add any MCP server or Claude Code plugin." },
];

// How to obtain the credential a card needs — surfaced in the config form as a deep "Create a token ↗" link, a
// required-scopes line, and a short step-by-step behind an info disclosure. A hosted provider uses an absolute
// `url`; a self-hostable one builds the link from a config field's live value (`urlFromField` + `path`), so it
// points at github.com or the user's own instance, and simply hides until that field holds an http(s) URL.
export interface CapabilityGuide {
    readonly url?: string | undefined;
    readonly urlFromField?: string | undefined;
    readonly path?: string | undefined;
    // Overrides the default "Create a token" link label.
    readonly linkLabel?: string | undefined;
    // The subtle "Scopes: …" line under the link — the permissions the token needs.
    readonly scopes?: string | undefined;
    // Ordered how-to-get-it steps, revealed in an InfoHint disclosure.
    readonly steps?: readonly string[] | undefined;
}

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
    // An @intentic-app/ui IconName rendered when no simple-icons `logo` fits the brand (before the per-kind
    // fallback). undefined → the generic per-kind icon.
    readonly icon?: string | undefined;
    readonly description: string;
    readonly requires?: readonly CapabilityKind[] | undefined;
    readonly fields: readonly CapabilityField[];
    readonly hint?: string | undefined;
    readonly guide?: CapabilityGuide | undefined;
}

export const CAPABILITY_CATALOG: readonly CapabilityCatalogEntry[] = [
    {
        id: "devops",
        name: "DevOps",
        kind: "devops",
        category: "platform",
        description: "Self-host and deploy: scaffolds your intent + desired-state repos, each with its own operator panel.",
        fields: [],
        hint: "One-time setup — then provision hosts, services and apps.",
    },
    {
        id: "monorepo",
        name: "pnpm + turbo monorepo",
        kind: "monorepo",
        category: "platform",
        description: "Scaffold an empty pnpm + turbo monorepo as its own repo; add apps (API / Web / Landing) to it from its operator panel.",
        fields: [],
        hint: "Names the repo. Once it's created, open its panel to add a Hono API, a Vue web app, or an Astro landing page.",
    },
    {
        id: "stripe",
        name: "Stripe",
        kind: "integration",
        category: "business",
        logo: "stripe",
        description: "Connect your Stripe account for the agent and app.",
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
        description: "Run containers inside your sandbox — its own isolated Docker Engine + Compose for dev databases, stacks and builds.",
        fields: [],
        hint: "One-time rebuild required — the sandbox restarts privileged with its own isolated Docker Engine (your machine's Docker is never shared).",
    },
    {
        id: "ssh",
        name: "SSH",
        kind: "ssh",
        category: "servers",
        icon: "server",
        description: "Give the agent a remote machine to operate over SSH.",
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
            { key: "privateKey", label: "Private key", secret: true, multiline: true, when: { key: "auth", value: "key" } },
            { key: "password", label: "Password", secret: true, when: { key: "auth", value: "password" } },
        ],
        hint: 'The name is the alias the agent uses (ssh <name> "…").',
        guide: {
            steps: [
                "Use a dedicated key or account scoped to what the agent should reach.",
                "Generate one: ssh-keygen -t ed25519 -f agent_key, then add agent_key.pub to the server's authorized_keys.",
                "Paste the unencrypted private key here.",
                "Or switch Authentication to Password and paste the password instead.",
            ],
        },
    },
    {
        id: "vpn",
        name: "VPN",
        kind: "vpn",
        category: "servers",
        icon: "shield",
        description: "Put the sandbox on a private network — WireGuard, FortiGate SSL-VPN (FortiClient) or IPsec.",
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
                when: { key: "provider", value: "wireguard" },
            },

            // FortiGate SSL-VPN — the <sslvpn> connections in a FortiClient export. Import fills these in.
            { key: "server", label: "Gateway", placeholder: "vpn.example.com", when: { key: "provider", value: "fortinet" } },
            { key: "port", label: "Port", default: "443", when: { key: "provider", value: "fortinet" } },
            { key: "username", label: "Username", when: { key: "provider", value: "fortinet" } },
            { key: "password", label: "Password", secret: true, when: { key: "provider", value: "fortinet" } },
            {
                key: "realm",
                label: "Realm / user group",
                optional: true,
                placeholder: "only if your gateway uses one",
                when: { key: "provider", value: "fortinet" },
            },
            {
                key: "trustedCert",
                label: "Trusted certificate",
                optional: true,
                placeholder: "sha256:… (only for a self-signed gateway)",
                when: { key: "provider", value: "fortinet" },
            },

            // IPsec — the <ipsecvpn> connections in a FortiClient export.
            { key: "server", label: "Gateway", placeholder: "vpn.example.com", when: { key: "provider", value: "ipsec" } },
            { key: "presharedKey", label: "Pre-shared key", secret: true, when: { key: "provider", value: "ipsec" } },
            {
                key: "localId",
                label: "Local ID",
                optional: true,
                placeholder: "the group name your gateway expects",
                when: { key: "provider", value: "ipsec" },
            },
            { key: "username", label: "XAuth username", optional: true, when: { key: "provider", value: "ipsec" } },
            { key: "password", label: "XAuth password", secret: true, optional: true, when: { key: "provider", value: "ipsec" } },
            {
                key: "ikeVersion",
                label: "IKE version",
                default: "1",
                options: [
                    { value: "1", label: "IKEv1" },
                    { value: "2", label: "IKEv2" },
                ],
                when: { key: "provider", value: "ipsec" },
            },
            {
                key: "pfs",
                label: "Perfect Forward Secrecy",
                default: "on",
                options: [
                    { value: "on", label: "On" },
                    { value: "off", label: "Off" },
                ],
                when: { key: "provider", value: "ipsec" },
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
                when: { key: "provider", value: "ipsec" },
            },
            {
                key: "aggressive",
                label: "Aggressive mode",
                default: "on",
                options: [
                    { value: "on", label: "On" },
                    { value: "off", label: "Off" },
                ],
                when: { key: "provider", value: "ipsec" },
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
                "WireGuard: paste the full .conf ([Interface] + [Peer]) from your provider or server.",
                "FortiGate SSL-VPN: use the gateway host and port your FortiClient connection uses (e.g. vpn.example.com:10443 → host + 10443).",
                "IPsec: the pre-shared key, plus your XAuth username and password if the gateway asks for them.",
                "Have a FortiClient config file? Use “Import from FortiClient” above to fill this in from it.",
                "If the gateway asks for a 2FA code, connect from the Status card and enter the code there.",
            ],
        },
    },
    {
        id: "reddit",
        name: "Reddit",
        kind: "browser",
        category: "communication",
        logo: "reddit",
        description: "Read, comment, post, vote and join subreddits — the agent acts as you in a real logged-in browser.",
        fields: [{ key: "platform", label: "", value: "reddit" }],
        hint: "Use Log in to sign in once — the agent then acts as you on Reddit. Automating an account may be against Reddit's terms — use your own.",
    },
    {
        id: "x",
        name: "X (Twitter)",
        kind: "browser",
        category: "communication",
        logo: "x/f5f5f5",
        description: "Read, reply, post, like, follow and join Communities — the agent acts as you in a real logged-in browser.",
        fields: [{ key: "platform", label: "", value: "x" }],
        hint: "Use Log in to sign in once — the agent then acts as you on X. Automating an account may be against X's terms — use your own.",
    },
    {
        id: "youtube",
        name: "YouTube",
        kind: "browser",
        category: "communication",
        logo: "youtube",
        description: "Watch, comment, reply, like and subscribe (join channels) — the agent acts as you in a real logged-in browser.",
        fields: [{ key: "platform", label: "", value: "youtube" }],
        hint: "Use Log in to sign in once — the agent then acts as you on YouTube. Google is strict about automated logins — completing sign-in yourself in the window is what gets past that.",
    },
    {
        id: "custom",
        name: "Custom MCP server",
        kind: "mcp",
        category: "extend",
        description: "Connect any remote MCP server by URL and token.",
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
        description: "Install a Claude Code plugin from a git repo — skills, agents, hooks and MCP servers.",
        fields: [
            { key: "url", label: "Git URL", placeholder: "https://github.com/owner/plugin" },
            { key: "ref", label: "Branch, tag or commit", optional: true },
            { key: "path", label: "Subdirectory", optional: true },
            { key: "token", label: "Access token", secret: true, optional: true },
        ],
        hint: "Loaded by the agent next turn. Re-adding the same name updates it.",
        guide: {
            scopes: "private repos: read access (e.g. GitHub repo)",
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
        description: "Install an intentic extension from a git repo — app views, commands, settings, agent skills and background processes.",
        fields: [
            { key: "url", label: "Git URL", placeholder: "https://github.com/owner/extension" },
            // A full sha, not a branch: extension code runs trusted in your browser, so installs pin exactly
            // the reviewed commit — updating is re-adding at a new sha.
            { key: "ref", label: "Commit sha (full 40 characters)" },
            { key: "path", label: "Subdirectory", optional: true },
            { key: "token", label: "Access token", secret: true, optional: true },
        ],
        guide: {
            scopes: "private repos: read access (e.g. GitHub repo)",
            steps: [
                "Point at a git repo with an intentic-extension.json at its root (or the subdirectory).",
                "Pin the exact commit sha you reviewed — branches and tags are not accepted.",
                "Private repo: add a token with read access.",
                "Reload the app after installing to load its UI; agent contributions load next turn.",
            ],
        },
    },
    // ACP agents (Agent Client Protocol): any agent speaking ACP over stdio becomes a chat provider. Curated
    // presets pre-fill the command; the custom card takes any command from the ACP registry.
    {
        id: "opencode-acp",
        name: "OpenCode",
        kind: "agent",
        category: "extend",
        logo: "opencode",
        description: "Run OpenCode as a chat provider over ACP — its own models, tools and config, driven from this chat.",
        fields: [
            { key: "command", label: "Command", default: "opencode acp" },
            { key: "name", label: "Display name", default: "OpenCode", optional: true },
            { key: "env", label: "Environment (KEY=VALUE per line)", secret: true, optional: true, multiline: true },
            { key: "loginCommand", label: "Login command", default: "opencode auth login", optional: true },
        ],
        hint: "Sign in by running the login command in a Terminal once — the agent keeps its own credentials in the sandbox.",
    },
    {
        id: "gemini-acp",
        name: "Gemini CLI",
        kind: "agent",
        category: "extend",
        logo: "googlegemini",
        description: "Run Google's Gemini CLI as a chat provider over ACP.",
        fields: [
            { key: "command", label: "Command", default: "gemini --experimental-acp" },
            { key: "name", label: "Display name", default: "Gemini", optional: true },
            { key: "env", label: "Environment (KEY=VALUE per line)", placeholder: "GEMINI_API_KEY=…", secret: true, optional: true, multiline: true },
            { key: "loginCommand", label: "Login command", optional: true },
        ],
        hint: "Provide GEMINI_API_KEY in the environment, or run the CLI's login in a Terminal once.",
    },
    {
        id: "acp-agent",
        name: "Custom ACP agent",
        kind: "agent",
        category: "extend",
        description:
            "Run any agent speaking the Agent Client Protocol (stdio) as a chat provider — Goose, Qwen Code, anything from the ACP registry.",
        fields: [
            { key: "command", label: "Command", placeholder: "npx -y my-acp-agent" },
            { key: "name", label: "Display name", optional: true },
            { key: "env", label: "Environment (KEY=VALUE per line)", secret: true, optional: true, multiline: true },
            { key: "loginCommand", label: "Login command", optional: true },
        ],
        hint: "The command must be on the sandbox PATH and speak ACP over stdio (split on whitespace — no shell quoting). Credentials go in the environment block, or run the login command in a Terminal once.",
        guide: {
            url: "https://agentclientprotocol.com",
            linkLabel: "Browse ACP agents",
            steps: [
                "Pick an agent from the ACP registry (agentclientprotocol.com) and note its run command.",
                "If it needs an API key, add it as a KEY=VALUE line in the environment block.",
                "For device-code sign-ins, add the agent's login command and run it in a Terminal after adding.",
                "The agent then appears as a provider in the chat's model picker.",
            ],
        },
    },
];

const isCapabilityCategory = (category: string): category is CapabilityCategory => CAPABILITY_CATEGORIES.some((entry) => entry.id === category);

// A cli connector contribution rendered as a catalog card — the "+" grid derives one card per connector from
// the INSTALLED extensions (GET /extensions), so a card exists iff its capability is actually addable, and the
// connector manifest is the single source of the card's name/logo/fields/guide (no static duplicate to drift).
// The provider becomes both the card id (the /capabilities/<id> slug) and the fixed `provider` config field the
// daemon's cli handler resolves. A third-party connector declaring a category outside CAPABILITY_CATEGORIES
// lands under "extend" (the catch-all section).
export const connectorCard = (connector: ConnectorContribution): CapabilityCatalogEntry => ({
    id: connector.provider,
    name: connector.catalog.name,
    kind: "cli",
    category: isCapabilityCategory(connector.catalog.category) ? connector.catalog.category : "extend",
    logo: connector.catalog.logo,
    icon: connector.catalog.icon,
    description: connector.catalog.description,
    fields: [{ key: "provider", label: "", value: connector.provider }, ...connector.fields],
    hint: connector.catalog.hint,
    guide: connector.catalog.guide,
});

// Automation "start from" recipes moved to the automations extension (@intentic/ext-automations): they are
// automation-UI prefill data, so they live with that extension rather than the platform product catalog.
