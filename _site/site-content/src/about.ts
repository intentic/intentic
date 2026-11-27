import { productHref } from "./product";
import { githubProfileUrl, githubUrl, linkedinProfileUrl, personalSiteUrl } from "./site";

// Who builds this, as data, shared by the landing page's trust band and /about/. Every claim here must be checkable:
// linkable to a public profile, or measured from this repo at build time (`gitStats()`), never authored as a number. No
// testimonials, logo walls, or vague claims.

/** Link to a profile a reader can check; `logo` keys into AboutLinks.astro's glyph map. */
export interface AboutLink {
    label: string;
    href: string;
    logo: "github" | "linkedin" | "globe";
}

/** A hover card's words, held by the site's kit to its budgets (site/DESIGN.md, "Detail on demand"). */
export interface KitTip {
    title: string;
    body: string;
    rows?: { label: string; value: string }[];
    link?: { label: string; href: string };
}

/** One checkable claim as a card; `stat` is filled at build time, never authored. */
export interface TrustCard {
    title: string;
    body: string;
    /** For a page built from the site's kit (/about/): the registry glyph, the one line `body` comes down to, the
     *  rest of `body` as the tile's Tip, and `linkLabel` cut to an action's four words. The landing band reads
     *  `body` and `linkLabel` as they are. */
    kit?: { icon: string; line: string; tip: KitTip; action: string };
    /** Which build-time number this card wants, if any. */
    stat?: "commits";
    /** Where the reader goes to check it. */
    href?: string;
    linkLabel?: string;
    /** A second link beside the first, for a card whose claim has a caveat the reader should be able to open. */
    secondary?: { href: string; label: string };
}

/** A line of the background list: the lead is bolded, the rest is context. */
export interface BackgroundItem {
    lead: string;
    body: string;
    /** What the timeline prints in the margin beside it: a span, a year, or a discipline. */
    marker: string;
}

/** One headline figure in the strip under the hero. `stat` is filled at build time, never authored. */
export interface AboutFigure {
    /** The figure itself, when it is a number this file may honestly assert. */
    value?: number;
    /** A figure that is a word, set rather than counted. */
    word?: string;
    /** Set after the figure, at its size. */
    suffix?: string;
    /** Which build-time number this slot wants instead. */
    stat?: "commits";
    /** Four words at most: what the figure counts. */
    label: string;
    /** What the label left out. */
    tip?: KitTip;
}

/** An open-source library that shipped and got used, independently of intentic. */
export interface OpenSourceProject {
    name: string;
    body: string;
    href: string;
}

export const CREATOR_NAME = "Artur Kurowski";
export const CREATOR_HANDLE = "radarsu";

// Split so no `\S+@\S+` exists in served HTML; assembled in the browser to dodge harvesters.
export const CONTACT_EMAIL_PARTS = { user: "radarsu", domain: "gmail.com" } as const;

export const creatorLinks: AboutLink[] = [
    { label: "GitHub", href: githubProfileUrl, logo: "github" },
    { label: "LinkedIn", href: linkedinProfileUrl, logo: "linkedin" },
    { label: "radarsu.com", href: personalSiteUrl, logo: "globe" },
];

export const creatorRole = "Full-stack engineer, DevOps, and 15+ years of shipping production systems.";

export const creatorBio = "Developer's job has changed. We're now AI operators. It requires different toolset.";

// Leads with the claim, not the name, since the band a reader just left already led with the name.
export const aboutHero = {
    eyebrow: "About the creator",
    headline: "Built in the open, by one engineer and his agents.",
    lede: "intentic has no investors, growth team or usage data to sell. One engineer with fifteen years of production experience builds it with a fleet of agents. The public commit log shows their work.",
    portraitAlt: `${CREATOR_NAME}, the creator of intentic`,
};

// Fourth card admits the product is new; a trust section with no admission reads as marketing.
export const trustCards: TrustCard[] = [
    {
        title: "Why trust intentic?",
        body: "Self-hosted. The platform holds only your identity and sandbox URL, never your code or keys.",
        href: productHref("host"),
        linkLabel: "What the platform actually holds",
        kit: {
            icon: "self-hosting",
            line: "Self-hosted. The platform never holds your code or keys.",
            tip: { title: "What it holds", body: "The platform holds only your identity and your sandbox URL." },
            action: "See what it holds",
        },
    },
    {
        title: "Open source first",
        body: "All of intentic is MIT on GitHub, with no hidden binaries. A sandbox you run sends us nothing. The app and desktop app have optional product analytics: a masked replay that leaves your workspace text out, and a switch under Settings, Data. intentic.dev/privacy lists what is recorded.",
        href: githubUrl,
        linkLabel: "Read the source",
        secondary: { href: "/privacy/", label: "What analytics records" },
        kit: {
            icon: "code",
            line: "All of intentic is MIT on GitHub, with no hidden binaries.",
            tip: {
                title: "Optional analytics",
                body: "A sandbox you run sends us nothing. The app and desktop app have optional product analytics: a masked replay that leaves your workspace text out, and a switch under Settings, Data.",
                link: { label: "See what it records", href: "/privacy/" },
            },
            action: "Read the source",
        },
    },
    {
        title: "It builds itself",
        body: "Agents wrote most of intentic in public, and every commit they made sits in the log.",
        stat: "commits",
        href: `${githubUrl}/commits/main`,
        linkLabel: "Read the commit log",
        kit: {
            icon: "branch",
            line: "Agents wrote most of intentic in public.",
            tip: { title: "Every commit logged", body: "Every commit they made sits in the public log, and this page counts them when it is built." },
            action: "Read the commit log",
        },
    },
    {
        title: "It is new",
        body: "There are no customer counts, testimonials or maturity claims yet.",
    },
];

// Ordered as a career runs, not as a ranked list; `marker` is the timeline's margin span.
export const background: BackgroundItem[] = [
    { marker: "Education", lead: "CS degree", body: "from the Polish-Japanese Academy of Information Technology (PJATK), Warsaw." },
    {
        marker: "Billon",
        lead: "Distributed ledger, in production",
        body: "the first company to receive an EU e-money licence using its own distributed ledger technology.",
    },
    { marker: "5 years", lead: "Ran a software house", body: "of around 15 people, shipping client systems end to end." },
    { marker: "Leadership", lead: "CTO and team lead", body: "shipped the systems, and led the people and habits around them." },
    { marker: "Specialties", lead: "Backend to bare metal", body: "TypeScript, NestJS, P2P protocols, CI/CD, and clean architecture." },
];

// Only the commit figure is measured at build time; it simply doesn't render if git can't answer.
export const aboutFigures: AboutFigure[] = [
    {
        stat: "commits",
        label: "commits by agents",
        tip: {
            title: "Written in public",
            body: "Commits written by agents, in public, counted from the repository's history when this page was built.",
            link: { label: "Read the commit log", href: `${githubUrl}/commits/main` },
        },
    },
    { value: 15, suffix: "+", label: "years shipping production systems" },
    {
        word: "MIT",
        label: "the whole engine's licence",
        tip: { title: "No hidden binaries", body: "The whole engine is MIT, with no hidden binaries.", link: { label: "Read the source", href: githubUrl } },
    },
];

/** What a screen reader calls the strip of figures, which has no heading of its own. */
export const aboutStripLabel = "Checkable figures";

/** The labels of the build-time commit counts, wherever they are printed as label/value rows. */
export const commitRows = { agents: "By agents", total: "All commits", since: "Since" };

// The trust band's head on /about/. The fourth card's admission is its lede, and the line that used to follow the
// cards (every claim is a link out) is the band's how-it-works, behind its (i).
export const aboutClaims = {
    eyebrow: "Why trust it",
    heading: "Three things you can check without asking me.",
    lede: "It is new: there are no customer counts, testimonials or maturity claims yet.",
    tip: {
        title: "Links, not claims",
        body: "Everything here is a link out to something you can read without taking my word for any of it.",
    },
} satisfies { eyebrow: string; heading: string; lede: string; tip: KitTip };

export const openSource: OpenSourceProject[] = [
    {
        name: "ts-import",
        body: "Import TypeScript files into plain Node.js at runtime, with no compile step.",
        href: "https://github.com/radarsu/ts-import",
    },
    {
        name: "rpc-websocket-client",
        body: "A small, typed JSON-RPC 2.0 client over WebSockets with async/await.",
        href: "https://github.com/radarsu/rpc-websocket-client",
    },
    {
        name: "validate-polish",
        body: "Validators for Polish identifiers (PESEL, NIP, REGON) that actually pass the checksum tests.",
        href: "https://github.com/radarsu/validate-polish",
    },
    {
        name: "options-defaults",
        body: "Deep-merge options objects with their defaults, predictably.",
        href: "https://github.com/radarsu/options-defaults",
    },
];

export const whyIntentic = [
    "Agents became capable of real work, but still lacked the tools and access to finish it.",
    "intentic gives them real tools, useful context and access to your systems, all under your control.",
];

export const aboutMeta = {
    title: `About · ${CREATOR_NAME}, the creator of intentic`,
    description:
        "Who builds intentic: Artur Kurowski, a full-stack engineer with 15+ years in production systems. Verifiable background and MIT source on GitHub.",
    datePublished: "2026-08-02",
};
