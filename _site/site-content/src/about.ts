import { productHref } from "./product";
import { githubProfileUrl, githubUrl, linkedinProfileUrl, personalSiteUrl } from "./site";

/* Who builds this, as data: shared by the landing page's trust band and by /about/.
 *
 * It exists because the site asks for an unusual amount of trust: a visitor is about to run a container
 * on their own machine and hand it a GitHub token, a database password and write access to a repo.
 * "The platform architecturally cannot reach in" answers half of that, and since the ownership band was
 * retired the first card below is the only place on the landing page that says it; the other half is
 * *who is making that promise*, and until now the founder existed only in the page's JSON-LD: told to
 * Google, never to the reader.
 *
 * The rule for everything in this file: it must be checkable. No testimonials, no logo wall, no
 * "trusted by N developers": the product is weeks old and the honest version of that is a strength
 * only if we say it plainly. Every claim below is either linkable to a public profile or measured from
 * this repository at build time (`gitStats()`), never authored as a number.
 */

/** A link out to a profile a reader can check. `logo` keys into the glyph map in AboutLinks.astro. */
export interface AboutLink {
    label: string;
    href: string;
    logo: "github" | "linkedin" | "globe";
}

/** One checkable claim, rendered as a card. `stat` is filled at build time, never authored. */
export interface TrustCard {
    title: string;
    body: string;
    /** Which build-time number this card wants, if any. */
    stat?: "commits";
    /** Where the reader goes to check it. */
    href?: string;
    linkLabel?: string;
}

/** A line of the background list: the lead is bolded, the rest is context. */
export interface BackgroundItem {
    lead: string;
    body: string;
    /** What the timeline prints in the margin beside it: a span, a year, or a discipline. */
    marker: string;
}

/** One headline figure in the band under the hero. `stat` is filled at build time, never authored. */
export interface AboutFigure {
    /** The figure itself, when it is a constant this file may honestly assert. */
    value?: string;
    /** Which build-time number this slot wants instead. */
    stat?: "commits";
    detail: string;
}

/** An open-source library that shipped and got used, independently of intentic. */
export interface OpenSourceProject {
    name: string;
    body: string;
    href: string;
}

export const CREATOR_NAME = "Artur Kurowski";
export const CREATOR_HANDLE = "radarsu";

/* Split so no `\S+@\S+` exists anywhere in the served HTML: the address is assembled in the browser.
 * See AboutContact.astro: a human reads the parts, a harvester's regex finds nothing, and with
 * JavaScript off the address is still legible, just not clickable. */
export const CONTACT_EMAIL_PARTS = { user: "radarsu", domain: "gmail.com" } as const;

export const creatorLinks: AboutLink[] = [
    { label: "GitHub", href: githubProfileUrl, logo: "github" },
    { label: "LinkedIn", href: linkedinProfileUrl, logo: "linkedin" },
    { label: "radarsu.com", href: personalSiteUrl, logo: "globe" },
];

export const creatorRole = "Full-stack engineer, DevOps, and 15+ years of shipping production systems.";

export const creatorBio = "I wanted a real workspace for my agents, on my own hardware. Now it runs on yours too.";

/* The hero, which the landing band deliberately does NOT have.
 *
 * A reader arrives here from "More about who builds this →", so the one thing this page cannot do is repeat
 * the band they just clicked out of. The band leads with the name because it is a panel beside other panels;
 * the page leads with the claim, and lets the portrait and the byline carry the name. */
export const aboutHero = {
    eyebrow: "About the creator",
    headline: "Built in the open, by one engineer and his agents.",
    lede: "intentic has no investors, growth team or usage data to sell. One engineer with fifteen years of production experience builds it with a fleet of agents. The public commit log shows their work.",
    portraitAlt: `${CREATOR_NAME}, the creator of intentic`,
};

/* Four cards, and the fourth is the one that makes the other three believable. A trust section with no
 * admission in it reads as marketing; this product is new, and saying so is the position. */
export const trustCards: TrustCard[] = [
    {
        title: "Why trust intentic?",
        body: "Runs on hardware you own. The platform holds only your identity and sandbox URL, never your code or keys.",
        href: productHref("host"),
        linkLabel: "What the platform actually holds",
    },
    {
        title: "Open source first",
        body: "All of intentic is MIT on GitHub. No hidden binaries, no telemetry, nothing to trust blind.",
        href: githubUrl,
        linkLabel: "Read the source",
    },
    {
        title: "It builds itself",
        body: "Agents wrote most of intentic in public, and every commit they made sits in the log.",
        stat: "commits",
        href: `${githubUrl}/commits/main`,
        linkLabel: "Read the commit log",
    },
    {
        title: "It is new",
        body: "There are no customer counts, testimonials or maturity claims yet.",
    },
];

/* Read top to bottom as a spine rather than five bullets: the marker is what the timeline prints in the
 * margin, so the eye gets a span before it gets a sentence. Ordered as a career runs — the degree it started
 * from, the work, the shape of the work, and what all of it left behind — not as a ranked list of claims. */
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

/* The band under the hero: three figures a reader can go and check, and only one of them is authored here.
 * The commit split is measured from git at build time and simply does not render when git cannot answer,
 * which is the same rule every other number on this site follows. */
export const aboutFigures: AboutFigure[] = [
    { stat: "commits", detail: "commits written by agents, in public" },
    { value: "15+ years", detail: "shipping production systems" },
    { value: "MIT", detail: "the whole engine, no hidden binaries" },
];

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
