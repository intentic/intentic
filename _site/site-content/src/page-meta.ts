import { aboutMeta } from "./about";
import { developersHref, developersPages } from "./developers";
import { compareHref, compareIndex, comparePages } from "./compare";
import { docsHref, docsPages } from "./docs";
import { guidePages, guidesHref, guidesIndex } from "./guides";
import { landingContent } from "./landing";
import { productHref, productPages } from "./product";
import { referenceHref, referencePages } from "./reference";

export interface PageMeta {
    title: string;
    description: string;
    /** Authored, not derived: the day the page went up. dateModified comes from git at build time. */
    datePublished: string;
}

// Every indexable route, keyed by canonical path; head, OpenGraph and JSON-LD all read from here.
export const pageMeta: Record<string, PageMeta> = {
    "/": { ...landingContent.meta, datePublished: "2026-07-06" },
    "/privacy/": {
        title: "Privacy Policy · intentic",
        description: "What personal data the intentic platform processes, why, who it is shared with, and your rights under the GDPR.",
        datePublished: "2026-07-03",
    },
    "/terms/": {
        title: "Terms of Service · intentic",
        description: "The terms governing use of the intentic platform: accounts, sandboxes we host, the hosted plan, acceptable use and liability.",
        datePublished: "2026-07-03",
    },
    "/acceptable-use/": {
        title: "Acceptable Use Policy · intentic",
        description: "What you may and may not do with the intentic platform and a sandbox we host for you, and how we enforce it.",
        datePublished: "2026-08-13",
    },
    "/dpa/": {
        title: "Data Processing Agreement · intentic",
        description: "The GDPR Article 28 agreement covering personal data we process on your behalf in a sandbox we host.",
        datePublished: "2026-08-13",
    },
    "/subprocessors/": {
        title: "Sub-processors · intentic",
        description: "Every provider we use to run the intentic platform, what each one does, where it processes data and under what safeguard.",
        datePublished: "2026-08-13",
    },
    // Every sitemap route needs an entry here, or it falls back to BaseLayout's generic brand line.
    "/credits/": {
        title: "Credits · intentic",
        description:
            "The open-source works intentic uses that ask to be credited, with each licence and what was changed. DiceBear avatars and the Adventurer illustration set.",
        datePublished: "2026-08-15",
    },
    "/about/": aboutMeta,
    // Only the blog index is here; a post's title/description live in its own frontmatter instead.
    "/blog/": {
        title: "The intentic blog",
        description: "What we have worked out about running a fleet of coding agents, and what we got wrong on the way. Releases are on the changelog.",
        datePublished: "2026-09-04",
    },
    // Answers the quickstart's objection; description leads with what the app removes, not what it's built with.
    "/download/": {
        title: "Download Intentic for Windows and Linux",
        description:
            "Run an intentic sandbox on your computer without using a terminal. The desktop app installs Docker if needed, starts the sandbox and handles updates.",
        datePublished: "2026-08-02",
    },
    // Names the three answers, not the question: the doubt forms before sign-in, past where setup can reach.
    "/where-it-runs/": {
        title: "Where your intentic workspace runs",
        description:
            "Run your coding agents on our servers or on your own computer. What each costs, what it asks of you, and what the install does.",
        datePublished: "2026-08-29",
    },
    // Entries come from GitHub Releases at build; description says what changed, not version numbers.
    "/changelog/": {
        title: "Changelog · intentic",
        description:
            "What's new in intentic: every release that changed something you'd notice, in plain language, newest first. Published straight from the release.",
        datePublished: "2026-08-10",
    },
    // The gallery's rows come from the registry repo at build time; only its framing is authored here.
    "/extensions/": {
        title: "Extensions · intentic",
        description:
            "Browse published intentic extensions. Each listing shows what it adds, who wrote it and the exact source commit you would install.",
        datePublished: "2026-08-01",
    },
    // The title answers "intentic pricing" directly, in the result itself.
    "/pricing/": {
        title: "Pricing · intentic is free. Bring your own AI plan",
        description:
            "intentic is free and MIT: every sandbox, capability and shared workspace, no tiers and no card. Agents run on AI plans you already pay for. A hosted sandbox is the one thing sold.",
        datePublished: "2026-09-06",
    },
    [compareHref("")]: compareIndex.meta,
    [guidesHref("")]: guidesIndex.meta,
    ...Object.fromEntries(docsPages.map((page) => [docsHref(page.id), page.meta])),
    ...Object.fromEntries(developersPages.map((page) => [developersHref(page.id), page.meta])),
    // Entries come from the tree like the other books, so its <head> is as real as an authored page's.
    ...Object.fromEntries(referencePages.map((page) => [referenceHref(page.id), page.meta])),
    ...Object.fromEntries(productPages.map((page) => [productHref(page.slug), page.meta])),
    ...Object.fromEntries(comparePages.map((page) => [compareHref(page.slug), page.meta])),
    ...Object.fromEntries(guidePages.map((page) => [guidesHref(page.slug), page.meta])),
};

function normalize(path: string): string {
    return path.endsWith("/") ? path : `${path}/`;
}

export function getPageMeta(path: string): PageMeta | undefined {
    return pageMeta[normalize(path)];
}
