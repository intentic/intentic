export interface DocsPage {
    /** Route slug under /docs/; "" is the docs index. */
    id: string;
    /** Sidebar + breadcrumb label. */
    title: string;
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
                meta: {
                    title: "intentic docs — Overview",
                    description:
                        "How intentic gives each coding agent its own sandbox — a specialized workspace on hardware you own — and where to start in the docs.",
                    datePublished: "2026-07-23",
                },
            },
            {
                id: "quickstart",
                title: "Quickstart",
                meta: {
                    title: "Quickstart — intentic docs",
                    description:
                        "Sign in, name a sandbox, and paste one curl command to bring a live agent workspace up on your own machine. No inbound ports.",
                    datePublished: "2026-07-23",
                },
            },
            {
                id: "docker",
                title: "Docker setup",
                meta: {
                    title: "Docker setup — intentic docs",
                    description:
                        "What the sandbox container is, how Docker gets installed, the isolated in-sandbox engine, environment overlays, and the update helpers.",
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
                meta: {
                    title: "Architecture — intentic docs",
                    description:
                        "How intentic fits together — the thin platform, the per-agent sandbox on your hardware, the ownership and trust model, and the tunnel fabric.",
                    datePublished: "2026-07-23",
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
                meta: {
                    title: "Extensions — intentic docs",
                    description:
                        "intentic is a lean core plus an extension system. An extension is a git repo with a manifest, and it extends the agent as well as the UI.",
                    datePublished: "2026-07-31",
                },
            },
            {
                id: "extensions/build",
                title: "Build an extension",
                meta: {
                    title: "Build an extension — intentic docs",
                    description:
                        "Author an intentic extension end to end: the manifest, activate(), a rail view that reads from the daemon, and a sha-pinned install.",
                    datePublished: "2026-07-31",
                },
            },
            {
                id: "extensions/manifest",
                title: "Manifest reference",
                meta: {
                    title: "Extension manifest reference — intentic docs",
                    description:
                        "Every field of intentic-extension.json — views, commands, settings, connectors, processes, listeners, agent plugins, and the route allowlist.",
                    datePublished: "2026-07-31",
                },
            },
            {
                id: "extensions/publish",
                title: "Publish & marketplace",
                meta: {
                    title: "Publish an extension & the marketplace — intentic docs",
                    description:
                        "Your extension stays in your repo; a registry is a git repo of sha-pinned pointers. How listing, updates, and the trust model work.",
                    datePublished: "2026-07-31",
                },
            },
        ],
    },
    {
        label: "Guides",
        items: [
            {
                id: "autonomous-employees",
                title: "Autonomous employees",
                meta: {
                    title: "Turn sandboxes into autonomous employees — intentic docs",
                    description:
                        "Specialize a sandbox into an agent — its tools, systems, and context — give it work, make it event-driven, then scale to a team of them.",
                    datePublished: "2026-07-23",
                },
            },
            {
                id: "reference-architecture",
                title: "Reference architecture",
                meta: {
                    title: "Reference architecture — intentic docs",
                    description:
                        "An entire company assembled from intentic sandboxes — one co-piloted agent per role and team, connected to the services they share.",
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
