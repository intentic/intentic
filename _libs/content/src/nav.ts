export interface NavLink {
    label: string;
    href: string;
    external?: boolean;
}

export type NavEntry =
    | { type: "link"; label: string; href: string; prefix: string; external?: boolean }
    | { type: "dropdown"; label: string; prefix: string; items: NavLink[] };

export const navEntries: NavEntry[] = [
    {
        type: "dropdown",
        label: "Features",
        prefix: "/#",
        items: [
            { label: "Workspace", href: "/#onboarding" },
            { label: "Ownership", href: "/#ownership" },
            { label: "Capabilities", href: "/#capabilities" },
            { label: "Automations", href: "/#automations" },
            { label: "DevOps Engine", href: "/#devops" },
        ],
    },
    {
        type: "dropdown",
        label: "Docs",
        prefix: "/docs",
        items: [
            {
                label: "Getting Started",
                href: "https://github.com/radarsu/intentic#getting-started",
                external: true,
            },
            {
                label: "CLI Reference",
                href: "https://github.com/radarsu/intentic#capabilities",
                external: true,
            },
            {
                label: "Architecture",
                href: "https://github.com/radarsu/intentic/blob/main/ARCHITECTURE.md",
                external: true,
            },
        ],
    },
    {
        type: "link",
        label: "Release Notes",
        href: "https://github.com/radarsu/intentic/releases",
        prefix: "/release-notes",
        external: true,
    },
];
