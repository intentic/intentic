import type { FaqItem } from "./faq";
import { landingContent } from "./landing";
import { creatorSharePct, pool } from "./pool";
import { APP_URL } from "./site";

/* /pricing. The product is free; the one paid thing is the optional membership. "Pricing" is the
 * highest-intent click on a developer-tool site, and a visitor who finds no link assumes the price is
 * hidden, so the page says "free" where the question is asked (decision 2026-09-06, landing-blueprint.md).
 * The landing page carries no pricing band. Every figure comes from pool.ts; none is typed here. */

export interface PricingColumn {
    eyebrow: string;
    name: string;
    price: string;
    priceNote: string;
    includes: string[];
    // `primary` is on the FREE column on purpose: the emphasised call is the one that costs nothing.
    cta: { label: string; href: string; primary?: boolean };
    note: string;
}

const credits = pool.dailyCredits.toLocaleString("en-GB");

const columns: PricingColumn[] = [
    {
        eyebrow: "The product",
        name: "Free",
        price: "$0",
        priceNote: "MIT on GitHub, platform included",
        includes: [
            "As many sandboxes as your machine will run",
            "One hosted sandbox, with a monthly running-time allowance",
            "Every capability, free extension and automation",
            "Shared workspaces",
            "The desktop app, the sandbox API and the whole source tree",
        ],
        cta: { label: "Create your workspace", href: APP_URL, primary: true },
        note: "You pay your AI providers directly.",
    },
    {
        eyebrow: "Optional",
        name: "Membership",
        price: `$${pool.priceUsd}`,
        priceNote: "a month via Stripe, cancel any time",
        includes: [
            `${credits} credits a day`,
            `Premium extensions: each install donates ${pool.donationCredits} credits to its publisher`,
            "Paid services from the catalog, priced in credits",
            "The hosted sandbox: no running-time allowance, never reclaimed when idle",
            `${creatorSharePct}% of every credit spent reaches its creator`,
        ],
        cta: { label: "How the creator pool works", href: "/earn/" },
        note: "Nothing an agent does needs it.",
    },
];

const faq: FaqItem[] = [
    {
        id: "is-any-of-it-paid",
        question: "Is any of it paid?",
        answer: [
            `The product is not: every sandbox, capability and shared workspace is free, with no tiers and no card, and all of intentic is MIT. The one paid thing is an optional membership at $${pool.priceUsd} a month, for premium extensions and paid services other people publish, and for the hosted sandbox's limits.`,
        ],
    },
    {
        id: "do-i-need-membership",
        question: "Do I need it to run agents?",
        answer: [
            "No. Agents run on your own AI accounts and your own machine, and neither touches credits. Only the hosted sandbox differs: without a membership it has a monthly running-time allowance and is reclaimed, after a warning email, once it has gone unopened for the period published in the app.",
        ],
        more: { label: "Where your workspace runs", href: "/where-it-runs/" },
    },
    {
        id: "team-or-enterprise",
        question: "Is there a team or enterprise tier?",
        answer: ["No. Shared workspaces are part of the free product: invite a teammate by email and give them a role."],
    },
];

export const pricingContent = {
    eyebrow: "Pricing",
    heading: "intentic is free.",
    sub: "Every sandbox, capability and shared workspace is included. Agents run on the AI plans you already pay for; we never meter tokens or add a markup.",
    columns,
    // The economics band's own provider list, so the two cannot disagree about which plans work.
    providers: {
        heading: "What you do pay for: your own AI plans.",
        accounts: landingContent.economics.accounts,
        points: landingContent.economics.points,
    },
    faq,
};
