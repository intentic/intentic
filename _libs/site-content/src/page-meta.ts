export interface PageMeta {
    title: string;
    description: string;
    datePublished: string;
}

export const pageMeta: Record<string, PageMeta> = {
    // The landing page's real title/description come from the selected variant in landing.ts;
    // this entry is the fallback and the datePublished source.
    "/": {
        title: "intentic — A shared IDE for you and your agents",
        description:
            "A shared IDE for you and your agents. intentic gives each coding agent — Claude Code, Codex, or Grok — its own sandbox on hardware you own: the dev-tools its job needs really installed, wired to your systems, its context curated for one job — and every layer of that environment visible and yours to change. Run one, or ten in parallel. Free to start.",
        datePublished: "2026-07-06",
    },
    "/privacy/": {
        title: "Privacy Policy — intentic",
        description: "What personal data the intentic platform processes, why, who it is shared with, and your rights under the GDPR.",
        datePublished: "2026-07-03",
    },
    "/terms/": {
        title: "Terms of Service — intentic",
        description: "The terms governing use of the intentic platform: accounts, billing, acceptable use, and liability.",
        datePublished: "2026-07-03",
    },
};

function normalize(path: string): string {
    return path.endsWith("/") ? path : `${path}/`;
}

export function getPageMeta(path: string): PageMeta | undefined {
    return pageMeta[normalize(path)];
}
