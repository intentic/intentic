export interface DocsPage {
    /** Route slug under /docs/; "" is the docs index. */
    id: string;
    /** Sidebar + breadcrumb label. */
    title: string;
    /** <title> + meta description for the page. */
    meta: { title: string; description: string };
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
                    description: "How intentic gives each coding agent its own sandbox — a specialized workspace on hardware you own — and where to start in the docs.",
                },
            },
            {
                id: "quickstart",
                title: "Quickstart",
                meta: {
                    title: "Quickstart — intentic docs",
                    description: "Sign in, name a sandbox, and paste one curl command to bring a live agent workspace up on your own machine. No inbound ports.",
                },
            },
            {
                id: "docker",
                title: "Docker setup",
                meta: {
                    title: "Docker setup — intentic docs",
                    description: "What the sandbox container is, how Docker is installed, the isolated in-sandbox engine, environment overlays, and the update/rebuild/cleanup helpers.",
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
                    description: "The three tiers — platform, sandbox, provisioned infrastructure — the ownership/trust model, and the Cloudflare reachability fabric.",
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
                    description: "Specialize a sandbox into an agent — its tools, systems, and context — give it work, make it event-driven, then scale to a team of them.",
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
