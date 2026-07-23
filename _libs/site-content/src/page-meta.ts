export interface PageMeta {
    title: string;
    description: string;
    datePublished: string;
}

export const pageMeta: Record<string, PageMeta> = {
    // The landing page's real title/description come from the selected variant in landing.ts;
    // this entry is the fallback and the datePublished source.
    "/": {
        title: "intentic — Specialized agents that own their workspace",
        description:
            "A specialized agent is more than a prompt. intentic gives each coding agent — Claude Code, Codex, or Grok — its own sandbox: the libraries, dev-tools, and integrations its job needs, plus curated context, on hardware you own. Run one, or a whole team. Free to start.",
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
