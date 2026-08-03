import { aboutMeta } from "./about";
import { compareHref, compareIndex, comparePages } from "./compare";
import { docsHref, docsPages } from "./docs";
import { landingContent } from "./landing";
import { productHref, productPages } from "./product";

export interface PageMeta {
    title: string;
    description: string;
    /** Authored, not derived: the day the page went up. dateModified comes from git at build time. */
    datePublished: string;
}

// Every indexable route, keyed by canonical path. The layout resolves title, description and
// datePublished from here, so a page's <head>, its OpenGraph card, its JSON-LD and its markdown
// mirror can't disagree. Docs entries come straight from the docs tree; the landing page's copy
// comes from the landing content it renders.
export const pageMeta: Record<string, PageMeta> = {
    "/": { ...landingContent.meta, datePublished: "2026-07-06" },
    "/privacy/": {
        title: "Privacy Policy · intentic",
        description: "What personal data the intentic platform processes, why, who it is shared with, and your rights under the GDPR.",
        datePublished: "2026-07-03",
    },
    "/terms/": {
        title: "Terms of Service · intentic",
        description: "The terms governing use of the intentic platform: accounts, billing, acceptable use, and liability.",
        datePublished: "2026-07-03",
    },
    "/about/": aboutMeta,
    // The desktop app's download page. It is the answer to the objection the quickstart raises, so its
    // description leads with what the app removes rather than what it is built with.
    "/download/": {
        title: "Download Intentic for Windows and Linux",
        description:
            "The Intentic desktop app runs your agent sandbox on your own computer without a terminal. It installs Docker if you need it, starts the sandbox, keeps it updated, and opens your workspace.",
        datePublished: "2026-08-02",
    },
    // The gallery's ROWS come from the registry repo at build time; only its framing is authored here.
    "/extensions/": {
        title: "Extensions · intentic",
        description:
            "Every published intentic extension: what it adds, who wrote it, and the exact commit you'd install. A registry of pointers to other people's repositories; intentic hosts none of the code.",
        datePublished: "2026-08-01",
    },
    [compareHref("")]: compareIndex.meta,
    ...Object.fromEntries(docsPages.map((page) => [docsHref(page.id), page.meta])),
    ...Object.fromEntries(productPages.map((page) => [productHref(page.slug), page.meta])),
    ...Object.fromEntries(comparePages.map((page) => [compareHref(page.slug), page.meta])),
};

function normalize(path: string): string {
    return path.endsWith("/") ? path : `${path}/`;
}

export function getPageMeta(path: string): PageMeta | undefined {
    return pageMeta[normalize(path)];
}
