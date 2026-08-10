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
    /**
     * Pages that live UNDER this one — same shelf, indented in the sidebar. Only for real route nesting
     * (/docs/extensions/build/ under /docs/extensions/), never as an editorial grouping: that is what a
     * group's label is for, and conflating the two is how "Manifest reference" came to look like a peer of
     * "Extensions".
     */
    children?: DocsPage[];
}

/** A run of rows inside a shelf, optionally under its own sub-heading. */
export interface DocsGroup {
    /** Absent for a shelf's main run, where a heading would only repeat the shelf label. */
    label?: string;
    items: DocsPage[];
}

export interface DocsSection {
    label: string;
    /** Who arrives at this shelf and what they want — rendered under the label, in the sidebar and on the index. */
    audience: string;
    /** The page this shelf's nav row points at. Always a real page, so no menu row is a dead heading. */
    entry: string;
    groups: DocsGroup[];
}

/* The whole docs tree — the SIDEBAR's list, read by someone already inside the docs, and the single source the
 * top bar, the footer, the index and the prev/next footer all derive from.
 *
 * SHELVED BY WHO IS READING, not by lifecycle stage. The previous four shelves sorted by stage ("Get started",
 * "Guides", "Extend", "API reference") and it put installing, understanding and maintaining on one shelf while
 * a second shelf swallowed ten of twenty pages in a flat list — half the documentation in an undifferentiated
 * wall. Three questions actually bring people here, and they are questions about the READER: I want to know
 * what this is; I run the machine this thing lives on; I do the day's work in it; I am building against it.
 *
 * WHY NO "GUIDES" SHELF ANY MORE. There was a hub page listing every guide in three editorial groups the
 * sidebar knew nothing about, so a reader who arrived through it lost the grouping the moment they landed on a
 * page. The groups were right; the place was wrong. They are structure here now, and the hub is gone.
 *
 * SUB-GROUPS EXIST SO NO RUN EXCEEDS FIVE ROWS. A shelf a reader has to parse rather than scan is the wall
 * again at a different address, so the two long shelves carry sub-headings. */
export const docsSections: DocsSection[] = [
    {
        label: "Understand",
        audience: "What this is, before you install anything.",
        entry: "",
        groups: [
            {
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
        ],
    },
    {
        label: "Run a sandbox",
        audience: "You own the machine: install it, keep it, share it.",
        entry: "quickstart",
        groups: [
            {
                items: [
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
                        /* Retitled from "Updates & what never breaks". The old title was the page's ARGUMENT,
                         * which is the right thing for a <title> and the wrong thing for a sidebar row: at the
                         * rail's width it wrapped to two lines and pushed every row below it out of rhythm. The
                         * promise it makes is still the meta description, where the reader deciding whether to
                         * click actually reads it. */
                        id: "updates",
                        title: "Updates & rollback",
                        blurb: "The promises every update keeps, and the two lanes",
                        meta: {
                            title: "Updates: what we promise never breaks · intentic docs",
                            description:
                                "What an intentic update can never touch: your files survive every update and rollback, updates are offered rather than forced, breaking changes are flagged before you take them, and every release soaks on the beta lane before stable.",
                            datePublished: "2026-08-10",
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
        ],
    },
    {
        label: "Drive agents",
        audience: "The everyday work, and whole things built out of it.",
        entry: "parallel-agents",
        groups: [
            {
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
                ],
            },
            {
                /* The three pages that are not "how does this surface work" but "here is a whole thing someone
                 * built out of the four above". They read as a payoff and they were the reason the old Guides
                 * shelf felt shapeless: a reader looking for how capabilities work had to step over an entire
                 * company blueprint to reach it. */
                label: "Worked examples",
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
        ],
    },
    {
        label: "Build on it",
        audience: "Extend the product, or call it from your own code.",
        entry: "extensions",
        groups: [
            {
                label: "Extensions",
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
                        children: [
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
                            {
                                /* Last of the extension children, because it is the last question an author has:
                                 * build it, describe it, publish it, get paid for it. */
                                id: "extensions/economics",
                                title: "The creator pool",
                                blurb: "Premium listings, the revenue split, and the public ledger",
                                meta: {
                                    title: "The creator pool · intentic docs",
                                    description:
                                        "How premium extensions earn: the membership, the published split, the active-day unit, the anti-gaming rule, and the transparency ledger anyone can read.",
                                    datePublished: "2026-08-10",
                                },
                            },
                        ],
                    },
                ],
            },
            {
                /* Host API is a CHILD of HTTP API by route (/docs/sandbox-api/host/) but a PEER of it by
                 * subject: one is the daemon you call over the wire, the other is the object an extension is
                 * handed in-process. The sidebar follows the subject, because that is what a reader is picking
                 * between — the route nesting is an implementation detail of where the page lives. */
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
        ],
    },
];

/** A page with the shelf it sits on — what prev/next and search results need to say where they are. */
export interface DocsPlacement {
    page: DocsPage;
    section: DocsSection;
    group: DocsGroup;
}

function walk(page: DocsPage): DocsPage[] {
    return [page, ...(page.children ?? []).flatMap(walk)];
}

/** Every page in reading order, each carrying the shelf and group it belongs to. */
export const docsPlacements: DocsPlacement[] = docsSections.flatMap((section) =>
    section.groups.flatMap((group) => group.items.flatMap(walk).map((page) => ({ page, section, group }))),
);

export const docsPages: DocsPage[] = docsPlacements.map((placement) => placement.page);

/* THE TOP BAR'S DOCS MENU and the footer's docs column — one row per shelf.
 *
 * DERIVED now, where it used to be four hand-written lines. The authored version existed because the menu was
 * once `docsSections.map(...)` over a tree whose sections were pages, so every page written landed another row
 * in a hover panel and nineteen arrived before anyone stopped it. That failure was about deriving from PAGES.
 * Deriving from SHELVES is the opposite bargain: there are four, a new page never adds a row, and the menu can
 * no longer describe a shape the sidebar has stopped having — which is exactly how the two came to disagree.
 *
 * Each href is the shelf's own entry page, so no row is a dead heading. */
export const docsDestinations: readonly { label: string; href: string; description: string }[] = docsSections.map(
    (section) => ({ label: section.label, href: docsHref(section.entry), description: section.audience }),
);

export function docsHref(id: string): string {
    return id ? `/docs/${id}/` : "/docs/";
}

export function docsPage(id: string): DocsPage | undefined {
    return docsPages.find((page) => page.id === id);
}

export function docsPlacement(id: string): DocsPlacement | undefined {
    return docsPlacements.find((placement) => placement.page.id === id);
}

/**
 * The page before and after this one WITHIN ITS SHELF, plus the shelf they belong to.
 *
 * Shelf-scoped rather than tree-wide on purpose: the flat version walked all twenty pages as one line, so the
 * foot of "Your own machine" offered "Parallel agents" as the next thing to read and the docs claimed to be a
 * book you start at the front of. They are four shelves you pick one of.
 */
export function docsNeighbours(id: string): { section?: DocsSection; prev?: DocsPage; next?: DocsPage } {
    const placement = docsPlacement(id);
    if (placement === undefined) return {};
    const shelf = docsPlacements.filter((entry) => entry.section === placement.section).map((entry) => entry.page);
    const index = shelf.findIndex((page) => page.id === id);
    return { section: placement.section, prev: shelf[index - 1], next: shelf[index + 1] };
}
