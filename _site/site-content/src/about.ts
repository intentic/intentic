import { productHref } from "./product";
import { githubProfileUrl, githubUrl, linkedinProfileUrl, personalSiteUrl } from "./site";

/* Who builds this, as data — shared by the landing page's trust band and by /about/.
 *
 * It exists because the site asks for an unusual amount of trust: a visitor is about to run a container
 * on their own machine and hand it a GitHub token, a database password and write access to a repo.
 * "The platform architecturally cannot reach in" answers half of that (`#ownership`); the other half is
 * *who is making that promise*, and until now the founder existed only in the page's JSON-LD — told to
 * Google, never to the reader.
 *
 * The rule for everything in this file: it must be checkable. No testimonials, no logo wall, no
 * "trusted by N developers" — the product is weeks old and the honest version of that is a strength
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

/** A line of the background list — the lead is bolded, the rest is context. */
export interface BackgroundItem {
    lead: string;
    body: string;
}

/** An open-source library that shipped and got used, independently of intentic. */
export interface OpenSourceProject {
    name: string;
    body: string;
    href: string;
}

export const CREATOR_NAME = "Artur Kurowski";
export const CREATOR_HANDLE = "radarsu";

/* Split so no `\S+@\S+` exists anywhere in the served HTML — the address is assembled in the browser.
 * See AboutContact.astro: a human reads the parts, a harvester's regex finds nothing, and with
 * JavaScript off the address is still legible, just not clickable. */
export const CONTACT_EMAIL_PARTS = { user: "radarsu", domain: "gmail.com" } as const;

export const creatorLinks: AboutLink[] = [
    { label: "GitHub", href: githubProfileUrl, logo: "github" },
    { label: "LinkedIn", href: linkedinProfileUrl, logo: "linkedin" },
    { label: "radarsu.com", href: personalSiteUrl, logo: "globe" },
];

export const creatorRole = "Full-stack engineer, DevOps, and 15+ years of shipping production systems.";

export const creatorBio =
    "I built intentic because I wanted a real workspace for my own agents. Not a chat window, and not somebody else's cloud holding my source. It runs on my hardware, and now on yours.";

/* Four cards, and the fourth is the one that makes the other three believable. A trust section with no
 * admission in it reads as marketing; this product is genuinely new, and saying so is the position. */
export const trustCards: TrustCard[] = [
    {
        title: "Why trust intentic?",
        body: "Built by a verifiable person, and built so that trusting the person is optional. The platform holds your identity and a URL, with no path to your code, your keys, or your sandbox.",
        href: productHref("sandbox"),
        linkLabel: "What the platform actually holds",
    },
    {
        title: "Open source first",
        body: "All of intentic is MIT on GitHub — the parts that touch your credentials and the platform behind them. No hidden binaries, no telemetry. Read what executes on your hardware before you run it.",
        href: githubUrl,
        linkLabel: "Read the source",
    },
    {
        title: "It builds itself",
        body: "Agents running in this product wrote most of it, in public, one reviewable commit at a time. The fleet on this page is what shipped the page.",
        stat: "commits",
        href: `${githubUrl}/commits/main`,
        linkLabel: "Read the commit log",
    },
    {
        title: "Honest about its age",
        body: "No case studies, no testimonials, no logo wall. The project is young, and what you get is a real sandbox rather than a trial. Read what it does before pointing it at something you care about.",
    },
];

export const background: BackgroundItem[] = [
    { lead: "15+ years", body: "in professional software engineering, from backend and frontend through DevOps and bare metal." },
    {
        lead: "Billon",
        body: "the first company to receive an EU e-money licence using its own distributed ledger technology. Later ran a software house of ~15 people for five years.",
    },
    { lead: "CS degree", body: "from the Polish-Japanese Academy of Information Technology (PJATK), Warsaw." },
    { lead: "CTO and team lead", body: "shipped the systems, and led the people and habits around them." },
    { lead: "Specialties", body: "TypeScript, NestJS, P2P protocols, CI/CD, and clean architecture." },
];

export const openSource: OpenSourceProject[] = [
    { name: "ts-import", body: "Import TypeScript files into plain Node.js at runtime, with no compile step.", href: "https://github.com/radarsu/ts-import" },
    { name: "rpc-websocket-client", body: "A small, typed JSON-RPC 2.0 client over WebSockets with async/await.", href: "https://github.com/radarsu/rpc-websocket-client" },
    { name: "validate-polish", body: "Validators for Polish identifiers (PESEL, NIP, REGON) that actually pass the checksum tests.", href: "https://github.com/radarsu/validate-polish" },
    { name: "options-defaults", body: "Deep-merge options objects with their defaults, predictably.", href: "https://github.com/radarsu/options-defaults" },
];

export const whyIntentic = [
    "Agents got good enough to do real work, and the tools around them did not. The only layer you are allowed to change is the prompt; the environment the agent works in is somebody else's, and so is the machine.",
    "That trade is fine until the agent needs your database password to do the job. Then \"whose computer is this?\" stops being a philosophical question. intentic is the other answer: the workspace is yours, the hardware is yours, and the vendor is architecturally unable to reach either.",
];

export const aboutMeta = {
    title: `About · ${CREATOR_NAME}, the creator of intentic`,
    description:
        "Who builds intentic: Artur Kurowski, a full-stack engineer with 15+ years in production systems. Verifiable background, MIT source on GitHub, and a commit log the agents wrote.",
    datePublished: "2026-08-02",
};
