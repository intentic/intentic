import { aboutMeta } from "./about";
import { apiHref, apiPages } from "./api";
import { compareHref, compareIndex, comparePages } from "./compare";
import { docsHref, docsPages } from "./docs";
import { guidePages, guidesHref, guidesIndex } from "./guides";
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
// mirror can't disagree. Both books' entries come straight from their trees; the landing page's
// copy comes from the landing content it renders.
export const pageMeta: Record<string, PageMeta> = {
    "/": { ...landingContent.meta, datePublished: "2026-07-06" },
    "/privacy/": {
        title: "Privacy Policy · intentic",
        description: "What personal data the intentic platform processes, why, who it is shared with, and your rights under the GDPR.",
        datePublished: "2026-07-03",
    },
    "/terms/": {
        title: "Terms of Service · intentic",
        description: "The terms governing use of the intentic platform: accounts, sandboxes we host, membership, acceptable use and liability.",
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
    "/about/": aboutMeta,
    // The desktop app's download page. It is the answer to the objection the quickstart raises, so its
    // description leads with what the app removes rather than what it is built with.
    "/download/": {
        title: "Download Intentic for Windows and Linux",
        description:
            "The Intentic desktop app runs your agent sandbox on your own computer without a terminal. It installs Docker if you need it, starts the sandbox, keeps it updated, and opens your workspace.",
        datePublished: "2026-08-02",
    },
    /* What shipped, in the words of the people it shipped for. Its ENTRIES come from the published GitHub
     * Releases at build time (site/src/lib/changelog.ts): only the framing is authored here, exactly like the
     * gallery below. The description says "what changed" rather than naming versions: the page is read by
     * someone deciding whether to update, not by someone auditing a version history. */
    "/changelog/": {
        title: "Changelog · intentic",
        description:
            "What's new in intentic: every release that changed something you'd notice, in plain language, newest first. Written as the work shipped and published straight from the release.",
        datePublished: "2026-08-10",
    },
    // The gallery's ROWS come from the registry repo at build time; only its framing is authored here.
    "/extensions/": {
        title: "Extensions · intentic",
        description:
            "Every published intentic extension: what it adds, who wrote it, and the exact commit you'd install. A registry of pointers to other people's repositories; intentic hosts none of the code.",
        datePublished: "2026-08-01",
    },
    /* The economy's own page, top-level because it serves members and creators alike. Its FIGURES come from
     * pool.ts at render time; only the framing is authored here. */
    "/earn/": {
        title: "Earn · intentic",
        description:
            "One membership, one currency: credits. Installs donate them, service runs spend them, and every credit spent pays its creator a published share, on a public ledger.",
        datePublished: "2026-08-11",
    },
    /* The numbers themselves. Deliberately not part of the argued page: /earn/fine-print/ explains what the
     * platform promises, and this is where a reader goes to check it — read live in their own browser from the
     * public endpoint, so nothing here is authored. */
    "/earn/ledger/": {
        title: "The ledger · Earn · intentic",
        description:
            "Every month of the creator pool, live from the platform: what came in, what payment processing cost, what the pool was, what reached creators, and what is still owed.",
        datePublished: "2026-08-12",
    },
    // The argued version of every promise /earn makes. Its own page so the short one stays scannable.
    "/earn/fine-print/": {
        title: "The fine print · Earn · intentic",
        description:
            "Every promise the Earn page makes, argued in full: the credit arithmetic, why there is no telemetry, why farming loses money, the service rules, the public ledger, and what exists today.",
        datePublished: "2026-08-11",
    },
    [compareHref("")]: compareIndex.meta,
    [guidesHref("")]: guidesIndex.meta,
    ...Object.fromEntries(docsPages.map((page) => [docsHref(page.id), page.meta])),
    ...Object.fromEntries(apiPages.map((page) => [apiHref(page.id), page.meta])),
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
