// Platform UI/product catalogs: the add-form descriptors + card data the web renders. NOT wire contract —
// moved out of @intentic-app/api-contract so the contract holds only schemas. Daemon enums are imported.
import type { CapabilityKind, InventoryProvider, ServiceKind } from "@intentic/sandbox-contract";

// Catalog the web uses to render the add forms. Only the user-provided, non-secret fields appear here.
export interface InventoryFieldDescriptor {
    readonly key: string;
    readonly label: string;
    readonly kind: "text" | "number";
}
export interface InventoryProviderDescriptor {
    readonly provider: InventoryProvider;
    readonly label: string;
    readonly fields: readonly InventoryFieldDescriptor[];
}
// The backends addable via the infra operator panel's Configuration form. Cloudflare is NOT here — it needs a
// token + zone, so it's added through the dedicated CloudflareConnect step (which writes the secret), never this bare form.
export const INVENTORY_PROVIDERS: readonly InventoryProviderDescriptor[] = [
    {
        provider: "host",
        label: "Server",
        fields: [
            { key: "address", label: "Address", kind: "text" },
            { key: "user", label: "SSH user", kind: "text" },
            { key: "port", label: "SSH port", kind: "number" },
        ],
    },
];
// The self-hosted service catalog the infra operator panel's "Add service" dialog renders: one card per deployable service
// (logo is a simple-icons slug, like CapabilityCatalogEntry.logo), then the per-service fields form.
export interface InventoryServiceDescriptor {
    readonly service: ServiceKind;
    readonly label: string;
    readonly logo: string;
    readonly description: string;
    readonly fields: readonly InventoryFieldDescriptor[];
}
export const INVENTORY_SERVICES: readonly InventoryServiceDescriptor[] = [
    {
        service: "signoz",
        label: "SigNoz",
        logo: "signoz",
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
        // No infisical slug in simple-icons yet — the dialog falls back to the per-kind icon on load error.
        service: "infisical",
        label: "Infisical",
        logo: "infisical",
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

// One field the "+" dialog renders for a capability's config form.
export interface CapabilityField {
    readonly key: string;
    readonly label: string;
    readonly placeholder?: string;
    readonly secret?: boolean;
    readonly optional?: boolean;
    // Render a multi-line <textarea> instead of a single-line <input> — a single-line input strips the newlines
    // when a multi-line value (e.g. a PEM private key) is pasted, corrupting it.
    readonly multiline?: boolean;
    // A fixed value baked into config, not shown as an input — e.g. service="signoz", provider="stripe".
    readonly value?: string;
    // A pre-filled default the user can edit (e.g. the "self"/"cf" bindings DevOps registers).
    readonly default?: string;
    // A user-chosen value from a fixed set — rendered as a Segmented selector instead of a text input.
    readonly options?: readonly { readonly value: string; readonly label: string }[];
    // Show/require/send this field only when another field currently equals a value (e.g. the SSH credential
    // that matches the chosen auth mode). Omitted → always shown.
    readonly when?: { readonly key: string; readonly value: string };
}

// The logical section a card sits under in the "+" grid — a display grouping (by what it's for), not the
// technical `kind`. `platform` cards unlock a new workspace area; the rest are connectors to existing tools.
export type CapabilityCategory = "platform" | "code" | "observability" | "data" | "communication" | "business" | "servers" | "extend";

// The grid's sections, in render order, with their headers. Cards are grouped by `category` under these.
export const CAPABILITY_CATEGORIES: readonly { readonly id: CapabilityCategory; readonly label: string; readonly hint: string }[] = [
    { id: "platform", label: "Platform", hint: "Scaffold managed repos that appear as their own operator panels." },
    { id: "code", label: "Code & issues", hint: "Repos, issues and pipelines as agent tools." },
    { id: "observability", label: "Observability", hint: "Query errors, traces, logs and metrics." },
    { id: "data", label: "Data", hint: "Let the agent query your SQL databases." },
    { id: "communication", label: "Communication", hint: "Let the agent read and send messages." },
    { id: "business", label: "Business & docs", hint: "Connect payments and knowledge bases." },
    { id: "servers", label: "Servers", hint: "Give the agent remote machines over SSH and private networks over VPN." },
    { id: "extend", label: "Extend", hint: "Add any MCP server or Claude Code plugin." },
];

// How to obtain the credential a card needs — surfaced in the config form as a deep "Create a token ↗" link, a
// required-scopes line, and a short step-by-step behind an info disclosure. A hosted provider uses an absolute
// `url`; a self-hostable one builds the link from a config field's live value (`urlFromField` + `path`), so it
// points at github.com or the user's own instance, and simply hides until that field holds an http(s) URL.
export interface CapabilityGuide {
    readonly url?: string;
    readonly urlFromField?: string;
    readonly path?: string;
    // Overrides the default "Create a token" link label.
    readonly linkLabel?: string;
    // The subtle "Scopes: …" line under the link — the permissions the token needs.
    readonly scopes?: string;
    // Ordered how-to-get-it steps, revealed in an InfoHint disclosure.
    readonly steps?: readonly string[];
}

// The grid the rail's "+" renders. Every card is a capability *type*; the user names each instance (→ its id,
// defaulted to `id`), so a provider can have N instances (two Discord bots, two databases). `requires` cards are
// shown but gated until the prereq is active.
export interface CapabilityCatalogEntry {
    readonly id: string;
    readonly name: string;
    readonly kind: CapabilityKind;
    readonly category: CapabilityCategory;
    // A simple-icons slug (https://cdn.simpleicons.org/<logo>); undefined → a generic per-kind icon. A "/<hex>"
    // suffix forces a color for icons invisible on the dark canvas (e.g. github's near-black).
    readonly logo?: string;
    readonly description: string;
    readonly requires?: readonly CapabilityKind[];
    readonly fields: readonly CapabilityField[];
    readonly hint?: string;
    readonly guide?: CapabilityGuide;
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
        id: "github",
        name: "GitHub",
        kind: "cli",
        category: "code",
        logo: "github/f5f5f5",
        description: "Issues, PRs and code search as agent tools — plus git clone/pull/push in the terminal.",
        fields: [
            { key: "provider", label: "", value: "github" },
            { key: "token", label: "Personal access token", secret: true },
            {
                key: "git",
                label: "Git access",
                default: "on",
                options: [
                    { value: "on", label: "On" },
                    { value: "off", label: "Off" },
                ],
            },
        ],
        hint: 'The agent uses the token with curl against the GitHub API. With Git access on you can git pull/push in the terminal — ssh-form URLs work too (rerouted over HTTPS when native SSH isn\'t available), so any repo-scoped token works. For native ssh://git we register an SSH key to your account, which needs write:public_key on a classic PAT (or the "Git SSH keys: write" permission on a fine-grained token); without it git still works over HTTPS and we show the key to add manually.',
        guide: {
            url: "https://github.com/settings/tokens",
            scopes: "repo (+ write:public_key / Git SSH keys: write for native ssh)",
            steps: [
                "Open Settings → Developer settings → Personal access tokens.",
                "Classic: generate a token with the repo scope (add write:public_key for native ssh://git).",
                'Fine-grained: grant repo Contents access (add the "Git SSH keys: write" account permission for native ssh://git).',
                "Copy the token and paste it here. Git works over HTTPS regardless; the extra permission only enables native ssh.",
            ],
        },
    },
    {
        id: "sentry",
        name: "Sentry",
        kind: "cli",
        category: "observability",
        logo: "sentry",
        description: "Query issues and traces from your Sentry org.",
        fields: [
            { key: "provider", label: "", value: "sentry" },
            { key: "url", label: "Sentry URL", placeholder: "https://sentry.io", default: "https://sentry.io" },
            { key: "org", label: "Org slug", optional: true },
            { key: "token", label: "Auth token", secret: true },
        ],
        hint: "Self-hosted: set your instance URL above first. Leave the org blank to let the agent list your orgs.",
        guide: {
            urlFromField: "url",
            path: "/settings/account/api/auth-tokens/",
            scopes: "project:read event:read org:read",
            steps: [
                "Open Settings → Account → Auth Tokens (or Developer Settings → Internal Integration).",
                "Create a token with the project:read, event:read and org:read scopes.",
                "Copy the token and paste it here.",
            ],
        },
    },
    {
        id: "discord",
        name: "Discord",
        kind: "cli",
        category: "communication",
        logo: "discord",
        description: "Let the agent read and post in your Discord server.",
        fields: [
            { key: "provider", label: "", value: "discord" },
            { key: "botToken", label: "Bot token", secret: true },
            {
                key: "voiceModel",
                label: "Voice model",
                default: "medium",
                options: [
                    { value: "tiny", label: "Tiny" },
                    { value: "base", label: "Base" },
                    { value: "small", label: "Small" },
                    { value: "medium", label: "Medium" },
                    { value: "large-v3-turbo", label: "Large" },
                ],
            },
            { key: "voiceLanguage", label: "Voice language", placeholder: "auto", optional: true },
        ],
        hint: "Voice transcription runs a local whisper model: bigger = more accurate but slower on CPU (Medium ≈ 1.5GB download on first use). Set the voice language to an ISO code like pl or en to pin transcription (auto-detect can misfire on short utterances).",
        guide: {
            url: "https://discord.com/developers/applications",
            linkLabel: "Open the Discord developer portal",
            scopes: "Privileged intents: Message Content + Server Members",
            steps: [
                "New Application → Bot.",
                "Reset Token, then copy the bot token.",
                "Enable the Message Content and Server Members privileged intents.",
                "Paste the token here, then ask the agent to “invite yourself to my server” — it makes a one-click invite link.",
            ],
        },
    },
    {
        id: "gitlab",
        name: "GitLab",
        kind: "cli",
        category: "code",
        logo: "gitlab",
        description: "Issues, merge requests, and pipelines as agent tools — plus git clone/pull/push in the terminal.",
        fields: [
            { key: "provider", label: "", value: "gitlab" },
            { key: "url", label: "Instance URL", placeholder: "https://gitlab.com", default: "https://gitlab.com" },
            { key: "token", label: "Access token", secret: true },
            {
                key: "git",
                label: "Git access",
                default: "on",
                options: [
                    { value: "on", label: "On" },
                    { value: "off", label: "Off" },
                ],
            },
        ],
        hint: "The agent uses the token with curl against the GitLab API. With Git access on, we register an SSH key to your account (the api scope covers key upload) so you can git clone/pull/push over ssh://git in the terminal; if key upload is refused, ssh-form URLs are rerouted over HTTPS so git still works.",
        guide: {
            urlFromField: "url",
            path: "/-/user_settings/personal_access_tokens",
            linkLabel: "Create an access token",
            scopes: "api",
            steps: [
                "Self-hosted: set the Instance URL above first.",
                "Open User settings → Access tokens.",
                "Add a token with the api scope.",
                "Copy the token and paste it here.",
            ],
        },
    },
    {
        id: "signoz-query",
        name: "SigNoz",
        kind: "cli",
        category: "observability",
        logo: "signoz",
        description: "Query traces, logs and metrics from a SigNoz instance.",
        fields: [
            { key: "provider", label: "", value: "signoz" },
            { key: "url", label: "SigNoz URL", placeholder: "https://signoz.example.com" },
            { key: "apiKey", label: "API key", secret: true },
        ],
        hint: "The agent queries observability with curl.",
        guide: {
            urlFromField: "url",
            path: "/settings/api-keys",
            scopes: "Viewer role is enough",
            steps: [
                "Set the SigNoz URL above (Cloud or self-hosted).",
                "Open Settings → API Keys and create a key (Viewer role).",
                "Copy the key and paste it here.",
            ],
        },
    },
    {
        id: "sql",
        name: "SQL database",
        kind: "cli",
        category: "data",
        logo: "postgresql",
        description: "Query your PostgreSQL or MySQL database from the agent.",
        fields: [
            {
                key: "provider",
                label: "Engine",
                default: "postgres",
                options: [
                    { value: "postgres", label: "PostgreSQL" },
                    { value: "mysql", label: "MySQL" },
                ],
            },
            { key: "host", label: "Host", placeholder: "db.example.com" },
            { key: "port", label: "Port", default: "5432" },
            { key: "user", label: "User", placeholder: "postgres" },
            { key: "password", label: "Password", secret: true },
            { key: "database", label: "Database", placeholder: "app" },
        ],
        hint: "The agent queries your database with psql/mysql.",
        guide: {
            steps: [
                "No external token — use an existing DB user, ideally a read-only one.",
                "Make sure the database is reachable from the sandbox (host/port open, grants/pg_hba allow it).",
                "PostgreSQL uses port 5432, MySQL 3306.",
                "Add this card again with a different name to connect another database.",
            ],
        },
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
        id: "redmine",
        name: "Redmine",
        kind: "cli",
        category: "code",
        logo: "redmine",
        description: "Connect your Redmine instance for issues and projects.",
        fields: [
            { key: "provider", label: "", value: "redmine" },
            { key: "url", label: "Instance URL", placeholder: "https://redmine.example.com" },
            { key: "apiKey", label: "API key", secret: true },
        ],
        hint: "The agent uses the API key with curl.",
        guide: {
            urlFromField: "url",
            path: "/my/account",
            linkLabel: "Open your Redmine account",
            scopes: "REST API must be enabled by an admin",
            steps: [
                "Set the Instance URL above first.",
                "Open My account (top-right).",
                "Under “API access key”, click Show (an admin enables it in Administration → Settings → API if hidden).",
                "Copy the key and paste it here.",
            ],
        },
    },
    {
        id: "outline",
        name: "Outline",
        kind: "cli",
        category: "business",
        logo: "outline/f5f5f5",
        description: "Connect your Outline wiki for docs and knowledge base.",
        fields: [
            { key: "provider", label: "", value: "outline" },
            { key: "url", label: "Instance URL", placeholder: "https://outline.example.com" },
            { key: "apiKey", label: "API token", secret: true },
        ],
        hint: "The agent uses the token with curl against the Outline API.",
        guide: {
            urlFromField: "url",
            path: "/settings/tokens",
            scopes: "the token inherits your permissions",
            steps: [
                "Set the Instance URL above first.",
                "Open Settings → API Tokens.",
                "Create a token and give it a name.",
                "Copy the token and paste it here.",
            ],
        },
    },
    {
        id: "imap",
        name: "IMAP",
        kind: "cli",
        category: "communication",
        description: "Connect an email inbox over IMAP for the agent to read.",
        fields: [
            { key: "provider", label: "", value: "imap" },
            { key: "host", label: "IMAP host", placeholder: "imap.gmail.com" },
            { key: "port", label: "Port", default: "993" },
            { key: "username", label: "Username", placeholder: "you@example.com" },
            { key: "password", label: "Password", secret: true },
        ],
        guide: {
            url: "https://myaccount.google.com/apppasswords",
            linkLabel: "Create a Gmail app password",
            steps: [
                "Gmail: turn on 2-Step Verification, then create an App Password (link above) and use it as the password.",
                "Outlook/Microsoft: account.microsoft.com → Security → Advanced security options → App passwords.",
                "Other hosts: your normal IMAP password works.",
                "Host/port — Gmail imap.gmail.com:993, Outlook outlook.office365.com:993.",
            ],
        },
    },
    {
        id: "ssh",
        name: "SSH",
        kind: "ssh",
        category: "servers",
        logo: "openssh",
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
        logo: "wireguard",
        description: "Route the agent's traffic through a WireGuard VPN.",
        fields: [
            { key: "config", label: "WireGuard config", secret: true, multiline: true, placeholder: "[Interface]\nPrivateKey = …\n\n[Peer]\n…" },
            // The `default` below is where we set whether a newly added VPN starts connected.
            {
                key: "enabled",
                label: "Connection",
                default: "on",
                options: [
                    { value: "on", label: "On" },
                    { value: "off", label: "Off" },
                ],
            },
        ],
        hint: "Re-add the same name to reconfigure or flip the connection on/off; an enabled tunnel survives restarts.",
        guide: {
            steps: [
                "Get a WireGuard .conf ([Interface] + [Peer]) from your VPN provider or server.",
                "Paste its full contents into the field above.",
                "The name becomes the tunnel interface (max 15 characters).",
                "Toggle Connection on to start it.",
            ],
        },
    },
    {
        id: "docker",
        name: "Docker",
        kind: "docker",
        category: "servers",
        logo: "docker",
        description: "Run Docker + Compose in the workspace, so a full-stack app's dev database (pnpm db:up) works.",
        fields: [
            {
                key: "enabled",
                label: "Daemon",
                default: "on",
                options: [
                    { value: "on", label: "On" },
                    { value: "off", label: "Off" },
                ],
            },
        ],
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
];

// Automation "start from" recipes moved to the automations extension (@intentic/ext-automations): they are
// automation-UI prefill data, so they live with that extension rather than the platform product catalog.
