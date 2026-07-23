import { docsHref, docsPages } from "./docs";

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
            { label: "Why specialized", href: "/#contrast" },
            { label: "Anatomy", href: "/#anatomy" },
            { label: "Workforce", href: "/#workforce" },
            { label: "Ownership", href: "/#ownership" },
            { label: "Get connected", href: "/#connect" },
        ],
    },
    {
        type: "dropdown",
        label: "Docs",
        prefix: "/docs",
        items: docsPages.map((page) => ({ label: page.title, href: docsHref(page.id) })),
    },
    {
        type: "link",
        label: "Release Notes",
        href: "https://gitlab.com/radarsu/intentic/-/releases",
        prefix: "/release-notes",
        external: true,
    },
];
