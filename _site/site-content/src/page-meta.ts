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
    /* The attribution page. It had no entry here, so it inherited the fallback in BaseLayout: the brand line as
     * its title and ORG_DESCRIPTION as its description, which at 285 characters is both truncated in a result
     * and about a different page entirely. Every route in the sitemap needs a line in this table for exactly
     * that reason. */
    "/credits/": {
        title: "Credits · intentic",
        description:
            "The open-source works intentic uses that ask to be credited, with each licence and what was changed. DiceBear avatars and the Adventurer illustration set.",
        datePublished: "2026-08-15",
    },
    "/about/": aboutMeta,
    /* The blog's index. Only the INDEX is here: a post's title and description live in its own frontmatter,
     * next to the words they describe, and `blog/[slug].astro` passes them to the layout directly. This
     * table is for pages whose copy has nowhere else to be. */
    "/blog/": {
        title: "The intentic blog",
        description: "What we have worked out about running a fleet of coding agents, and what we got wrong on the way. Releases are on the changelog.",
        datePublished: "2026-09-04",
    },
    // The desktop app's download page. It is the answer to the objection the quickstart raises, so its
    // description leads with what the app removes rather than what it is built with.
    "/download/": {
        title: "Download Intentic for Windows and Linux",
        description:
            "Run an intentic sandbox on your computer without using a terminal. The desktop app installs Docker if needed, starts the sandbox and handles updates.",
        datePublished: "2026-08-02",
    },
    /* The rung decision, made before the sign-in. Its description names the three answers rather than the
     * question, because the search it has to win is somebody asking whether this thing runs on their own
     * machine or on ours — a doubt they form before they will click "Create your workspace", and the one the
     * app's own setup screen cannot answer, being on the far side of a Google prompt. */
    "/where-it-runs/": {
        title: "Where your intentic workspace runs",
        description:
            "Run your coding agents on our servers or on your own computer. What each costs, what it asks of you, and what the install does.",
        datePublished: "2026-08-29",
    },
    /* What shipped, in the words of the people it shipped for. Its ENTRIES come from the published GitHub
     * Releases at build time (site/src/lib/changelog.ts): only the framing is authored here, exactly like the
     * gallery below. The description says "what changed" rather than naming versions: the page is read by
     * someone deciding whether to update, not by someone auditing a version history. */
    "/changelog/": {
        title: "Changelog · intentic",
        description:
            "What's new in intentic: every release that changed something you'd notice, in plain language, newest first. Published straight from the release.",
        datePublished: "2026-08-10",
    },
    // The gallery's ROWS come from the registry repo at build time; only its framing is authored here.
    "/extensions/": {
        title: "Extensions · intentic",
        description:
            "Browse published intentic extensions. Each listing shows what it adds, who wrote it and the exact source commit you would install.",
        datePublished: "2026-08-01",
    },
    /* The economy's own page, top-level because it serves members and creators alike. Its FIGURES come from
     * pool.ts at render time; only the framing is authored here. */
    "/earn/": {
        title: "Membership credits, creator pool & public ledger · intentic",
        description: "Credits to creators on install or run. Public ledger.",
        datePublished: "2026-08-11",
    },
    /* The numbers themselves. Deliberately not part of the argued page: /earn/fine-print/ explains what the
     * platform promises, and this is where a reader goes to check it, read live in their own browser from the
     * public endpoint, so nothing here is authored. */
    "/earn/ledger/": {
        title: "The ledger · Earn · intentic",
        description:
            "Every month of the creator pool, live from the platform: what came in, what processing cost, what reached creators, and what is still owed.",
        datePublished: "2026-08-12",
    },
    // The listings themselves, plus the wanted list, the demand side of the same live read.
    "/earn/catalog/": {
        title: "The catalog · Earn · intentic",
        description:
            "Every paid service agents can run, live from the platform: price, publisher, and each listing's served and refunded runs, plus what agents asked for that nobody serves yet.",
        datePublished: "2026-08-19",
    },
    // The argued version of every promise /earn makes. Its own page so the short one stays scannable.
    "/earn/fine-print/": {
        title: "The fine print · Earn · intentic",
        description:
            "Every promise the Earn page makes, argued in full: the credit arithmetic, why farming loses money, the service rules, and what exists today.",
        datePublished: "2026-08-11",
    },
    [compareHref("")]: compareIndex.meta,
    [guidesHref("")]: guidesIndex.meta,
    ...Object.fromEntries(docsPages.map((page) => [docsHref(page.id), page.meta])),
    ...Object.fromEntries(developersPages.map((page) => [developersHref(page.id), page.meta])),
    // The API book, five authored pages and 37 generated ones. Its entries come from the tree exactly as the
    // other two books' do, which is what keeps a generated page's <head> as real as an authored one's.
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
