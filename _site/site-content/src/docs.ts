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

/* The whole docs tree, in reading order — the SIDEBAR's list, read by someone already inside the docs.
 * nav/footer and the prev/next footer flatten it via docsPages below: one source of truth for slugs and titles.
 *
 * FOUR SECTIONS, deliberately the four every docs reader arrives expecting: install it, use it, extend it,
 * look something up. The tree once grew to six ("Understand" holding one page, guides split across two shelves
 * by which week they were written), and it read like an operating system's site map.
 *
 * WHAT THIS IS NOT is the top-bar menu. That is `docsDestinations` below, and the split is the whole point:
 * the menu used to be `docsSections.map(...)`, so every page written landed another labelled row in a hover
 * panel, and nineteen of them arrived before anyone said stop. A tree is what you read when you are already
 * here; a front door is four places to go. */
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
            {
                id: "updates",
                title: "Updates & what never breaks",
                blurb: "The promises every update keeps, and the two lanes",
                meta: {
                    title: "Updates: what we promise never breaks · intentic docs",
                    description:
                        "What an intentic update can never touch: your files survive every update and rollback, updates are offered rather than forced, breaking changes are flagged before you take them, and every release soaks on the beta lane before stable.",
                    datePublished: "2026-08-10",
                },
            },
        ],
    },
    {
        label: "Guides",
        items: [
            {
                id: "guides",
                title: "All guides",
                blurb: "Every guide, grouped by what you're doing",
                meta: {
                    title: "Guides · intentic docs",
                    description:
                        "Every intentic guide in one place: running agents, connecting systems, sharing a sandbox, and the worked examples built on top of them.",
                    datePublished: "2026-08-07",
                },
            },
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
                        "intentic is a lean core plus one extension format: a directory with a manifest whose every part is optional. It extends the agent, the UI and the backend.",
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
                        "Every field of intentic-extension.json: views, viewers, commands, settings, capability cards, processes, listeners, agent plugins, the backend, permissions.",
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
        label: "API reference",
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
                        "Every member of the IntenticApi object — the typed daemon client, views, documents, commands, models, routing — and the backend's activateServer surface.",
                    datePublished: "2026-08-07",
                },
            },
        ],
    },
];

export const docsPages: DocsPage[] = docsSections.flatMap((section) => section.items);

/* THE TOP BAR'S DOCS MENU — four places to go, not a table of contents.
 *
 * Authored rather than derived, and that is deliberate after the derived version: a menu built from the tree
 * grows a row per page written, which is how a hover panel ended up holding nineteen labelled links with
 * blurbs. Landing a new page must cost nothing here. Changing where the front door points is a decision, and
 * it should read as one — so it is four lines of prose someone chose, kept next to the tree they summarise.
 *
 * Each `href` is that area's real entry page, so no row is a dead heading. */
export const docsDestinations: readonly { label: string; href: string; description: string }[] = [
    { label: "Get started", href: docsHref(""), description: "Install a sandbox, and how the pieces fit" },
    { label: "Guides", href: docsHref("guides"), description: "Run agents, connect systems, share a sandbox" },
    { label: "Extend", href: docsHref("extensions"), description: "Build and publish extensions" },
    { label: "API reference", href: docsHref("sandbox-api"), description: "The daemon's HTTP API and the host API" },
];

export function docsHref(id: string): string {
    return id ? `/docs/${id}/` : "/docs/";
}

export function docsPage(id: string): DocsPage | undefined {
    return docsPages.find((page) => page.id === id);
}
