import { FREE_TIER, type HostedTier, PAID_TIERS } from "@intentic/constants";
import { CREATOR_NAME } from "./about";
import { compareHref } from "./compare";
import { docsHref } from "./docs";
import { idleWeeks } from "./hosted";
import { landingContent } from "./landing";
import { APP_URL, githubReleasesUrl, githubUrl } from "./site";

// /facts: one dated sheet of the plain answers an assistant or a buyer checks with a `site:` search
// (docs/marketing/llm-recommendation-factors.md, "One dated fact sheet"). A row is a question and its answer, nothing
// else: no adjectives, no argument. Prices, hours and the provider list are read from the modules the pricing and
// landing pages read, the version from GitHub at build; only the wording below is authored, and FACTS_CHECKED dates it.
// Dates arrive already written out: the page formats them, since the static site is where a fixed format belongs.

export const FACTS_PATH = "/facts/";

/** The day every authored row was last checked against the repository. Move it only after checking all of them again. */
export const FACTS_CHECKED = "2026-10-19";

export const factsMeta = {
    title: "intentic facts: what it is, license, price, where it runs",
    description:
        "A dated fact sheet for intentic: what it is, its MIT license, its price, where it runs, which agents it runs, how it isolates them and what the platform stores.",
    datePublished: "2026-10-19",
};

export const factsIntro = {
    eyebrow: "Facts",
    heading: "intentic, in facts",
    sub: "Short answers to what people check before they use it. Each one is checked against the source code.",
};

export interface FactLink {
    label: string;
    href: string;
}

export interface FactRow {
    /** Anchor id, so one fact is linkable and quotable on its own. */
    id: string;
    fact: string;
    answer: string;
    links?: FactLink[];
}

/** What only the build knows. A row whose figure could not be read is left out, never shown empty. */
export interface FactsLive {
    /** The newest GitHub release, its day written out; undefined when the API could not be read. */
    release: { version: string; released: string; url: string } | undefined;
    /** The first commit's day, written out; undefined in a shallow clone. */
    since: string | undefined;
}

const listed = (items: readonly string[]): string => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);

// The plans the pricing page and the landing economics band list, so this row cannot name a provider they do not.
const providers = landingContent.economics.accounts.map((account) => `${account.name} (${account.detail})`).join("; ");

// The machine ladder the pricing page prices, from the same constants, so the two pages quote one set of figures.
const machine = (tier: HostedTier): string =>
    `${tier.cpus} ${tier.cpuKind} vCPUs, ${tier.memoryMb / 1024} GB memory, ${tier.volumeGb} GB disk, ${tier.monthlyHours} awake hours a month`;
const paidSizes = listed(PAID_TIERS.map((tier) => `${tier.name} at $${tier.priceUsd} a month (${machine(tier)})`));

// What it is, and under what terms.
const productRows: FactRow[] = [
    {
        id: "what-it-is",
        fact: "What it is",
        answer: "An open-source workspace for coding agents: each one works in a sandbox, in its own git worktree, keeps running when you close the browser, and is steered from any device, with every change reviewed before it is merged.",
    },
    {
        id: "license",
        fact: "License",
        answer: "MIT, for the whole repository: the sandbox, the CLI, the desktop app, the web app and the platform.",
    },
    {
        id: "source",
        fact: "Source code",
        answer: "One public repository on GitHub, github.com/intentic/intentic.",
        links: [{ label: "GitHub", href: githubUrl }],
    },
    {
        id: "not-to-be-confused-with",
        fact: "Not to be confused with",
        answer: "Augment Code's Intent, a different agent workspace, or Intentic Technologies, a training company in Bengaluru. Neither is related to intentic.",
    },
];

// What it costs, and what is never charged for.
const priceRows: FactRow[] = [
    {
        id: "price",
        fact: "Price",
        answer: "Free. Every sandbox on your own hardware, every capability, automation and shared workspace is included, with no feature tiers and no card. You pay your AI provider directly.",
        links: [{ label: "Pricing", href: "/pricing/" }],
    },
    {
        id: "hosted",
        fact: "What is paid",
        answer: `Only a hosted sandbox: a machine of ours at Fly.io, in the EU (Stockholm) for users in the EEA, UK and Switzerland and in the US (Ashburn) for everyone else. A free size (${machine(FREE_TIER)}) needs Google linked to the account and is removed after ${idleWeeks} weeks unopened. Paid sizes: ${paidSizes}. Every size has every feature.`,
        links: [{ label: "Pricing", href: "/pricing/" }],
    },
    {
        id: "metering",
        fact: "Token metering",
        answer: "None. Agents run on your own AI plans or API keys; intentic never meters tokens or adds a markup. The optional free trial, for trying it with nothing connected, has a daily step limit and passes through intentic's servers.",
    },
];

// Which agents, on what, and how they are kept apart.
const runtimeRows: FactRow[] = [
    {
        id: "providers",
        fact: "AI providers",
        answer: `${providers}.`,
        links: [{ label: "Models and providers", href: docsHref("models") }],
    },
    {
        id: "agents",
        fact: "Agent harnesses",
        answer: "Depending on the provider, a turn runs in Claude Code, Codex, OpenCode, Muse Code or the provider's own agent (Cursor's, Devin's, Grok Build or Kimi CLI). Pi, and any agent that speaks the Agent Client Protocol (ACP), can be added as a capability.",
    },
    {
        id: "where-it-runs",
        fact: "Where it runs",
        answer: "In a container on your laptop, desktop or VPS: Linux, macOS, or Windows through WSL2. The desktop app covers Windows 10 and 11 and Linux; elsewhere one setup command does the same. Or on a hosted sandbox.",
        links: [
            { label: "Where it runs", href: "/where-it-runs/" },
            { label: "Quickstart", href: docsHref("quickstart") },
        ],
    },
    {
        id: "requirements",
        fact: "What you need",
        answer: "A container engine, which the desktop app and the setup command install if it is missing, asking first, and a Google account or any email address to sign in. No inbound port is opened: the sandbox dials out.",
    },
    {
        id: "isolation",
        fact: "Isolation",
        answer: "A sandbox is one container, running unprivileged and shared by many agents; separate roles or credentials get separate sandboxes. Each new agent conversation gets its own git worktree of every repository, on its own branch; its work reaches your working tree when it is landed, by you or automatically if you turn that on.",
        links: [{ label: "Parallel agents", href: docsHref("parallel-agents") }],
    },
];

// How you reach it, and what passes through or stays with the platform on the way.
const dataRows: FactRow[] = [
    {
        id: "access",
        fact: "Access",
        answer: `Any browser, on a computer or a phone, at ${APP_URL.replace(/^https:\/\//u, "")}. Runs continue with every browser closed, and the next device opens the same board.`,
    },
    {
        id: "platform-stores",
        fact: "What the platform stores",
        answer: "Your account, plus each sandbox's address and the token needed to reach it. Never what is inside: code, files, credentials and everything the agents produce are stored on your machine, or on the disk of a hosted sandbox.",
        links: [{ label: "Privacy policy", href: "/privacy/" }],
    },
    {
        id: "relay",
        fact: "What the relay sees",
        answer: "A sandbox opened at its intentic address is reached through intentic's relay at Fly.io in the US, which decrypts the traffic in memory to route it and stores none of it. Opened at its local address, or through a platform you host yourself, the traffic never reaches intentic.",
    },
];

// Who builds it and how often it ships; the version and first commit only when the build could read them.
const projectRows = (live: FactsLive): FactRow[] => [
    ...(live.release === undefined
        ? []
        : [
              {
                  id: "version",
                  fact: "Current version",
                  answer: `${live.release.version}, released ${live.release.released}.`,
                  links: [
                      { label: "Release notes", href: live.release.url },
                      { label: "Changelog", href: "/changelog/" },
                  ],
              },
          ]),
    {
        id: "releases",
        fact: "Release cadence",
        answer: "Continuous: every feature or fix merged to the main branch is released as a new version once CI passes. The changelog lists the releases with a change you would notice.",
        links: [{ label: "All releases", href: githubReleasesUrl }],
    },
    {
        id: "maker",
        fact: "Who makes it",
        answer: `${CREATOR_NAME}, one engineer with no investors, building it in public with a fleet of agents${live.since === undefined ? "" : `; first commit ${live.since}`}.`,
        links: [{ label: "About", href: "/about/" }],
    },
    {
        id: "maturity",
        fact: "Maturity",
        answer: "New: no case studies or testimonials yet.",
    },
];

export const factRows = (live: FactsLive): FactRow[] => [...productRows, ...priceRows, ...runtimeRows, ...dataRows, ...projectRows(live)];

/** Where to go once a fact has answered the question. */
export const factsNext: FactLink[] = [
    { label: "Pricing", href: "/pricing/" },
    { label: "Comparisons", href: compareHref("") },
    { label: "Quickstart", href: docsHref("quickstart") },
    { label: "About", href: "/about/" },
];
