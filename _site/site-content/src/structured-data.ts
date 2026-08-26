import { LEGAL_CONTACT_EMAIL } from "@intentic/constants";
import { creatorRole } from "./about";
import { APP_URL, FOUNDER_NAME, FOUNDER_SAME_AS, githubProfileUrl, LOGO_URL, ORG_DESCRIPTION, ORG_NAME, SAME_AS, SITE_URL } from "./site";

// One JSON-LD graph per page instead of a pile of standalone documents: every entity is declared once,
// under a stable @id, and everything else points at it. Consumers (Google, and any LLM reading the page)
// then resolve "the publisher" to the same node as "the organization" rather than reconciling two
// differently-shaped copies of it.
//
// @ids are anchored on the canonical origin: SITE_URL + "/". So they match the <link rel="canonical">
// exactly. A page's own nodes hang off its URL: <url>#webpage, <url>#breadcrumb, <url>#article.

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
    /** Renders the page as a TechArticle alongside its WebPage: for documentation. */
    article?: boolean;
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

/* The founder, with the profiles that make him checkable. `sameAs` is the part that matters: it is how a
 * search or answer engine resolves this Person to one it already has a file on, which is the whole point
 * of a trust section: the claim is not "trust me", it is "here is who I am, go look". */
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

/**
 * The page's own nodes, in graph form. FAQPage is a subclass of WebPage, so a page with questions is
 * typed FAQPage outright rather than carrying a second, near-duplicate node for the same URL.
 */
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

    const article = opts.article
        ? {
              "@type": "TechArticle",
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
          }
        : undefined;

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
 * `/about/` as a ProfilePage about the founder. It is a distinct type from WebPage because the page's
 * subject is a person rather than the product, which is what tells an answer engine that the entity
 * behind this domain is the one already described at those `sameAs` URLs.
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
        // Ordered the way the landing page argues: run many in parallel, on your hardware, nothing
        // landing unread, then the reasons those agents are any good.
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
