import { LEGAL_CONTACT_EMAIL } from "@intentic/constants";
import { creatorRole } from "./about";
import { APP_URL, FOUNDER_NAME, FOUNDER_SAME_AS, githubProfileUrl, LOGO_URL, ORG_DESCRIPTION, ORG_NAME, SAME_AS, SITE_URL } from "./site";

// One JSON-LD graph per page: each entity is declared once under a stable @id, so publisher and organization resolve to
// the same node rather than duplicating. @ids anchor on SITE_URL + "/", matching <link rel="canonical">; a page's own
// nodes hang off its URL (#webpage, #breadcrumb, #article).

const ORIGIN = `${SITE_URL}/`;
const ORG_ID = `${ORIGIN}#organization`;
const WEBSITE_ID = `${ORIGIN}#website`;
const FOUNDER_ID = `${ORIGIN}#founder`;
const LOGO_ID = `${ORIGIN}#logo`;
const SOFTWARE_ID = `${ORIGIN}#software`;

const orgRef = { "@id": ORG_ID } as const;
const founderRef = { "@id": FOUNDER_ID } as const;

export interface BreadcrumbEntry {
    name: string;
    path: string;
}

export interface FaqEntry {
    question: string;
    answer: string;
}

export interface PageGraphOptions {
    name: string;
    description: string;
    /** Canonical pathname, leading and trailing slash included. */
    path: string;
    datePublished?: string;
    dateModified?: string;
    /** Home is implicit and prepended; pass the trail below it. */
    breadcrumbs?: BreadcrumbEntry[];
    /** Renders the page as an article alongside its WebPage: for documentation. */
    article?: boolean;
    // Which kind, when article is set: TechArticle by default, BlogPosting for a dated post.
    articleType?: "TechArticle" | "BlogPosting";
    /** Present ⇒ the page node is a FAQPage carrying these as its mainEntity. */
    faq?: FaqEntry[];
    /** Extra top-level nodes to merge into the graph (e.g. the SoftwareApplication on the landing page). */
    extra?: Record<string, unknown>[];
}

function organizationNode() {
    return {
        "@type": "Organization",
        "@id": ORG_ID,
        name: ORG_NAME,
        url: ORIGIN,
        logo: { "@type": "ImageObject", "@id": LOGO_ID, url: LOGO_URL, contentUrl: LOGO_URL, width: 326, height: 326 },
        image: { "@id": LOGO_ID },
        description: ORG_DESCRIPTION,
        email: LEGAL_CONTACT_EMAIL,
        founder: founderRef,
        sameAs: [...SAME_AS],
    };
}

// The founder, with profiles that make him checkable. `sameAs` lets a search or answer engine resolve this Person to
// one it already knows.
function founderNode() {
    return {
        "@type": "Person",
        "@id": FOUNDER_ID,
        name: FOUNDER_NAME,
        url: githubProfileUrl,
        jobTitle: "Founder & engineer",
        description: creatorRole,
        sameAs: [...FOUNDER_SAME_AS],
    };
}

function websiteNode() {
    return {
        "@type": "WebSite",
        "@id": WEBSITE_ID,
        url: ORIGIN,
        name: ORG_NAME,
        description: ORG_DESCRIPTION,
        inLanguage: "en-US",
        publisher: orgRef,
    };
}

function breadcrumbNode(url: string, trail: BreadcrumbEntry[]) {
    const entries = [{ name: "Home", path: "/" }, ...trail];
    return {
        "@type": "BreadcrumbList",
        "@id": `${url}#breadcrumb`,
        itemListElement: entries.map((entry, i) => ({
            "@type": "ListItem",
            position: i + 1,
            name: entry.name,
            item: `${SITE_URL}${entry.path}`,
        })),
    };
}

/** FAQPage is a subclass of WebPage; a page with questions is typed FAQPage outright, not a duplicate node. */
// The article aspect of a page, hung off its WebPage node: one URL is one page with two aspects, not two documents.
// TechArticle or BlogPosting; everything else about the node is identical.
function articleNode(opts: PageGraphOptions, url: string, pageId: string) {
    return {
        "@type": opts.articleType ?? "TechArticle",
        "@id": `${url}#article`,
        headline: opts.name,
        description: opts.description,
        inLanguage: "en-US",
        mainEntityOfPage: { "@id": pageId },
        isPartOf: { "@id": pageId },
        author: founderRef,
        publisher: orgRef,
        ...(opts.datePublished ? { datePublished: opts.datePublished } : {}),
        ...(opts.dateModified ? { dateModified: opts.dateModified } : {}),
    };
}

export function buildPageGraph(opts: PageGraphOptions) {
    const url = `${SITE_URL}${opts.path}`;
    const pageId = `${url}#webpage`;
    const hasBreadcrumb = opts.breadcrumbs !== undefined && opts.breadcrumbs.length > 0;

    const page: Record<string, unknown> = {
        "@type": opts.faq ? "FAQPage" : "WebPage",
        "@id": pageId,
        url,
        name: opts.name,
        description: opts.description,
        inLanguage: "en-US",
        isPartOf: { "@id": WEBSITE_ID },
        about: orgRef,
        ...(opts.datePublished ? { datePublished: opts.datePublished } : {}),
        ...(opts.dateModified ? { dateModified: opts.dateModified } : {}),
        ...(hasBreadcrumb ? { breadcrumb: { "@id": `${url}#breadcrumb` } } : {}),
        ...(opts.faq
            ? {
                  mainEntity: opts.faq.map((entry) => ({
                      "@type": "Question",
                      name: entry.question,
                      acceptedAnswer: { "@type": "Answer", text: entry.answer },
                  })),
              }
            : {}),
    };

    const article = opts.article ? articleNode(opts, url, pageId) : undefined;

    return {
        "@context": "https://schema.org",
        "@graph": [
            organizationNode(),
            founderNode(),
            websiteNode(),
            page,
            ...(hasBreadcrumb ? [breadcrumbNode(url, opts.breadcrumbs!)] : []),
            ...(article ? [article] : []),
            ...(opts.extra ?? []),
        ],
    };
}

/**
 * /about/ as a ProfilePage, not a WebPage: its subject is the founder, which tells an answer engine the entity behind
 * this domain is the one at `sameAs`.
 */
export function buildProfilePageSchema(path: string) {
    return {
        "@type": "ProfilePage",
        "@id": `${SITE_URL}${path}#profile`,
        mainEntity: founderRef,
        about: founderRef,
        isPartOf: { "@id": WEBSITE_ID },
    };
}

export function buildSoftwareAppSchema() {
    return {
        "@type": "SoftwareApplication",
        "@id": SOFTWARE_ID,
        name: ORG_NAME,
        url: APP_URL,
        description: ORG_DESCRIPTION,
        applicationCategory: "DeveloperApplication",
        operatingSystem: "Docker on Linux, macOS, or Windows",
        offers: {
            "@type": "Offer",
            url: APP_URL,
            price: "0",
            priceCurrency: "USD",
            availability: "https://schema.org/InStock",
            description: "Free and MIT open source: unlimited sandboxes, with every capability, the agent and automations included.",
        },
        // Ordered like the landing page argues: parallel, your hardware, nothing lands unread, then why it's good.
        featureList: [
            "Run a fleet of coding agents in parallel, one isolated git worktree each",
            "One Docker sandbox for many agents, on hardware you choose",
            "Diff review before anything lands in your working tree",
            "Bring your own agent: Claude Code, Codex, Grok, Kimi Code, or Google",
            "Environment overlays: the job's dev-tools really installed",
            "Capabilities: repos, databases, and services wired in as credentials the agent operates",
            "Extensions: automations, Discord and Slack, a website Front Desk, memory, pipelines",
        ],
        author: founderRef,
        publisher: orgRef,
        isPartOf: { "@id": WEBSITE_ID },
    };
}
