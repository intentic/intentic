export interface DocsPage {
    /** Route slug under /docs/; "" is the docs index. */
    id: string;
    /** Sidebar + breadcrumb label. */
    title: string;
    /** One line of scent in the nav menu — shorter than meta.description, which is written for search results. */
    blurb: string;
    /**
     * <title>, meta description and publication date. Descriptions stay under 160 characters — past that
     * a search result truncates mid-sentence and the page loses whatever the tail was carrying.
     * dateModified is not here: it comes from the page's git history at build time.
     */
    meta: { title: string; description: string; datePublished: string };
}

export interface DocsSection {
    label: string;
    items: DocsPage[];
}

// The whole docs tree, in reading order. The sidebar renders it by section; nav/footer and the
// prev/next footer flatten it via docsPages below — one source of truth for slugs and titles.
export const docsSections: DocsSection[] = [
    {
        label: "Get started",
        items: [
            {
                id: "",
                title: "Overview",
                blurb: "What intentic is and where to start",
                meta: {
                    title: "intentic docs · Overview",
                    description:
                        "How intentic gives each coding agent its own sandbox, a specialized workspace on hardware you own, and where to start in the docs.",
                    datePublished: "2026-07-23",
                },
            },
            {
                id: "quickstart",
                title: "Quickstart",
                blurb: "Four ways to bring a sandbox up, end to end",
                meta: {
                    title: "Quickstart · intentic docs",
                    description:
                        "Bring a live agent workspace up on your own machine four ways: the desktop app, one setup command, Docker Compose, or plain docker run.",
                    datePublished: "2026-07-23",
                },
            },
            {
                id: "docker",
                title: "Docker setup",
                blurb: "What gets created, and how to live with it",
                meta: {
                    title: "Docker setup · intentic docs",
                    description:
                        "The anatomy every install path shares: the containers, volumes and network created, the capability posture, the nested engine, overlays and updates.",
                    datePublished: "2026-07-23",
                },
            },
        ],
    },
    {
        label: "Understand",
        items: [
            {
                id: "architecture",
                title: "Architecture",
                blurb: "The thin platform, your sandbox, the tunnel between",
                meta: {
                    title: "Architecture · intentic docs",
                    description:
                        "How intentic fits together: the thin platform, the per-agent sandbox on your hardware, the ownership model, and the tunnel fabric.",
                    datePublished: "2026-07-23",
                },
            },
        ],
    },
    {
        label: "Work with it",
        items: [
            {
                id: "parallel-agents",
                title: "Parallel agents",
                blurb: "Many agents at once, reviewed before anything lands",
                meta: {
                    title: "Parallel agents · intentic docs",
                    description:
                        "Run several agents at once, each in its own checkout of your repos, and review what they did before any of it reaches the tree you work in.",
                    datePublished: "2026-08-07",
                },
            },
            {
                id: "capabilities",
                title: "Capabilities",
                blurb: "Give the agent tools, systems and machines",
                meta: {
                    title: "Capabilities · intentic docs",
                    description:
                        "Connect GitHub, databases, MCP servers, SSH hosts and more. Where the credentials live, and what the agent actually receives.",
                    datePublished: "2026-08-07",
                },
            },
            {
                id: "automations",
                title: "Automations & workflows",
                blurb: "Work that starts without you, and multi-step runs",
                meta: {
                    title: "Automations, workflows & loops · intentic docs",
                    description:
                        "Wake an agent on a schedule, a webhook or a message; run several agents in order as a workflow; or loop one until the goal is met.",
                    datePublished: "2026-08-07",
                },
            },
            {
                id: "models",
                title: "Models & accounts",
                blurb: "Providers, harnesses, accounts and what they cost",
                meta: {
                    title: "Models & accounts · intentic docs",
                    description:
                        "Which model serves a turn: the provider, the connected account, the agentic loop it runs in, and where the spend is reported.",
                    datePublished: "2026-08-07",
                },
            },
            {
                id: "access",
                title: "Access & sharing",
                blurb: "One owner, invited people, enforced tiers",
                meta: {
                    title: "Access & sharing · intentic docs",
                    description:
                        "How the owner is decided, what each invited tier can do, and why the daemon rather than the UI is what enforces it.",
                    datePublished: "2026-08-07",
                },
            },
            {
                id: "your-machine",
                title: "Your own machine",
                blurb: "Desktop sync, connected computers, the editor bridge",
                meta: {
                    title: "Your own machine · intentic docs",
                    description:
                        "Sync a folder into the sandbox, let the agent operate your computer, or drive its agents from Zed or JetBrains over ACP.",
                    datePublished: "2026-08-07",
                },
            },
        ],
    },
    {
        label: "Extend",
        items: [
            {
                id: "extensions",
                title: "Extensions",
                blurb: "A lean core plus a directory with a manifest",
                meta: {
                    title: "Extensions · intentic docs",
                    description:
                        "intentic is a lean core plus an extension system. An extension is a directory with a manifest, and it extends the agent as well as the UI.",
                    datePublished: "2026-07-31",
                },
            },
            {
                id: "extensions/build",
                title: "Build an extension",
                blurb: "Author one end to end, in a repo or in your workspace",
                meta: {
                    title: "Build an extension · intentic docs",
                    description:
                        "Author an intentic extension end to end: manifest, activate(), a rail view — then a sha-pinned install, or run it straight from your workspace.",
                    datePublished: "2026-07-31",
                },
            },
            {
                id: "extensions/manifest",
                title: "Manifest reference",
                blurb: "Every field of intentic-extension.json",
                meta: {
                    title: "Extension manifest reference · intentic docs",
                    description:
                        "Every field of intentic-extension.json: views, commands, settings, connectors, processes, listeners, agent plugins, and the route allowlist.",
                    datePublished: "2026-07-31",
                },
            },
            {
                id: "extensions/publish",
                title: "Publish & marketplace",
                blurb: "Registries, updates and the trust model",
                meta: {
                    title: "Publish an extension & the marketplace · intentic docs",
                    description:
                        "Your extension stays in your repo; a registry is a git repo of sha-pinned pointers. How listing, updates, and the trust model work.",
                    datePublished: "2026-07-31",
                },
            },
        ],
    },
    {
        label: "Sandbox API",
        items: [
            {
                id: "sandbox-api",
                title: "HTTP API",
                blurb: "Every route your sandbox serves, and the credential to call it",
                meta: {
                    title: "Sandbox HTTP API · intentic docs",
                    description:
                        "Call your own sandbox over HTTP: the base URL, control tokens and their scopes, the route groups, the event streams, and the failures.",
                    datePublished: "2026-08-07",
                },
            },
            {
                id: "sandbox-api/host",
                title: "Host API",
                blurb: "The IntenticApi an extension is handed",
                meta: {
                    title: "Extension host API reference · intentic docs",
                    description:
                        "Every member of the IntenticApi object: the typed daemon client, workspace facts and files, views, documents, commands, models and routing.",
                    datePublished: "2026-08-07",
                },
            },
        ],
    },
    {
        label: "Guides",
        items: [
            {
                id: "doorbell",
                title: "Doorbell",
                blurb: "Put a chat on your website, answered by your agent",
                meta: {
                    title: "Doorbell · put your agent on your website · intentic docs",
                    description:
                        "Embed a chat widget on your site with one script tag. Visitors talk to your sandbox agent; you watch and take over from the fleet board.",
                    datePublished: "2026-08-01",
                },
            },
            {
                id: "autonomous-employees",
                title: "Autonomous employees",
                blurb: "Specialize a sandbox until it does a job alone",
                meta: {
                    title: "Turn sandboxes into autonomous employees · intentic docs",
                    description:
                        "Specialize a sandbox into an agent: its tools, systems and context. Give it work, make it event-driven, then scale to a team.",
                    datePublished: "2026-07-23",
                },
            },
            {
                id: "reference-architecture",
                title: "Reference architecture",
                blurb: "A whole company assembled from sandboxes",
                meta: {
                    title: "Reference architecture · intentic docs",
                    description:
                        "An entire company assembled from intentic sandboxes: one agent per role and team, connected to the services they share.",
                    datePublished: "2026-07-24",
                },
            },
        ],
    },
];

export const docsPages: DocsPage[] = docsSections.flatMap((section) => section.items);

export function docsHref(id: string): string {
    return id ? `/docs/${id}/` : "/docs/";
}

export function docsPage(id: string): DocsPage | undefined {
    return docsPages.find((page) => page.id === id);
}
