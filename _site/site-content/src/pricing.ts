import { FREE_TIER, HOSTED_TIERS, hostedShapeLine, PAID_TIERS } from "@intentic/constants";
import type { FaqItem } from "./faq";
import { hosted, idleWeeks, rampSpan } from "./hosted";
import { landingContent } from "./landing";
import { APP_URL } from "./site";

// /pricing: the product is free, a machine of ours is the only paid thing; every figure comes from the ladder in
// `@intentic/constants` or from hosted.ts, none typed here. Columns split on whose machine the agents run on, because
// that is the first question and the only one money answers. The ladder below them is three sizes of our machine, not
// three editions of the product: no feature, capability or automation is ever behind a rung. Both column notes say
// "your AI accounts", since AI plans are the reader's own either way.

export interface PricingColumn {
    eyebrow: string;
    name: string;
    price: string;
    priceNote: string;
    includes: string[];
    // `primary` is on the Free column: the emphasised call is the one that costs nothing.
    cta: { label: string; href: string; primary?: boolean };
    note: string;
}

/** One rung of the machine ladder as the page states it; derived from the ladder, never typed twice. */
export interface PricingMachine {
    id: string;
    name: string;
    price: string;
    priceNote: string;
    shape: string;
    hours: string;
    note: string;
}

// The cheapest thing that is sold, named once here so the column and the FAQ cannot quote different entry prices.
const entry = PAID_TIERS[0] as (typeof PAID_TIERS)[number];

const columns: PricingColumn[] = [
    {
        eyebrow: "Your machine",
        name: "Free",
        price: "$0",
        priceNote: "MIT on GitHub, platform included",
        includes: [
            "As many sandboxes as your hardware will run",
            "Every capability, extension and automation",
            "Shared workspaces: teammates by email",
            "The desktop app, the sandbox API and the whole source tree",
            "Unlimited hours. Nothing of ours is running, so nothing is metered",
        ],
        cta: { label: "Set up on my computer", href: "/where-it-runs/", primary: true },
        note: "Your machine, your AI accounts. Nothing to pay us.",
    },
    {
        eyebrow: "Our machine",
        name: "Hosted",
        price: `Free, then $${entry.priceUsd}`,
        priceNote: "a month per hosted sandbox via Stripe, cancel any time",
        includes: [
            `Free: one sandbox on ${hostedShapeLine(FREE_TIER)}, ${FREE_TIER.monthlyHours} awake hours a month (${hosted.newAccountHours} in ${rampSpan}), removed after ${idleWeeks} weeks unopened`,
            `Paid: a bigger machine and more hours, from $${entry.priceUsd} a month, and never removed`,
            "Every feature on every size. What money changes is the machine, never what an agent can do",
            `Sleeps after ${hosted.idleStopMinutes} minutes away; a sleeping machine spends no hours`,
            "Change size whenever you like: the workspace, the address and the disk stay as they are",
        ],
        cta: { label: "Start instantly", href: APP_URL },
        note: "Our machine, your AI accounts. Move the workspace to your own whenever you like; the plan is the only thing you cancel.",
    },
];

const machines: PricingMachine[] = HOSTED_TIERS.map((tier) => ({
    id: tier.id,
    name: tier.name,
    price: tier.priceUsd === 0 ? "$0" : `$${tier.priceUsd}`,
    priceNote: tier.priceUsd === 0 ? "no card" : "a month",
    shape: hostedShapeLine(tier),
    hours: `${tier.monthlyHours} awake hours a month`,
    note:
        tier.priceUsd === 0
            ? `One sandbox, ${hosted.newAccountHours} hours in ${rampSpan}, removed after ${idleWeeks} weeks unopened.`
            : `Kept for as long as you keep it. Another sandbox is another machine at its own price.`,
}));

const faq: FaqItem[] = [
    {
        id: "is-any-of-it-paid",
        question: "Is any of it paid?",
        answer: [
            `The product is not: every sandbox, capability and shared workspace is free, with no card, and all of intentic is MIT. The one paid thing is a machine of ours to run it on, from $${entry.priceUsd} a month.`,
            "There are no feature tiers. A bigger size is a bigger machine and more awake hours; nothing becomes possible on one that was impossible on another.",
        ],
    },
    {
        id: "do-i-need-the-plan",
        question: "Do I need it to run agents?",
        answer: [
            `No. Agents run on your own AI accounts, on any machine. Only the hosted sandbox differs: free, it has ${FREE_TIER.monthlyHours} awake hours a month (${hosted.newAccountHours} in ${rampSpan}) and is removed after ${idleWeeks} weeks unopened; paid, it is bigger, has more hours and is never removed.`,
        ],
        more: { label: "Where your workspace runs", href: "/where-it-runs/" },
    },
    {
        id: "changing-size",
        question: "What happens when I change size?",
        answer: [
            "Your sandbox keeps its address, its disk and everything on it. Moving up resizes the machine where it stands and takes about a minute, and we take a snapshot of the disk before touching anything.",
            "Moving down lowers the processors and memory at once and leaves you the disk you already have, because a disk can grow and not shrink.",
        ],
    },
    {
        id: "team-or-enterprise",
        question: "Is there a team or enterprise tier?",
        answer: ["No. Shared workspaces are part of the free product: invite a teammate by email and give them a role."],
    },
];

export const pricingContent = {
    eyebrow: "Pricing",
    heading: "intentic is free. A machine of ours is the one thing we sell.",
    sub: "Every feature, capability and shared workspace is included on any number of sandboxes on your own hardware. Agents run on the AI plans you already pay for; we never meter tokens or add a markup.",
    columns,
    machines: {
        heading: "Three sizes of our machine. Same product on every one.",
        sub: "A sleeping machine spends no hours, and the hours reset on the first of the month.",
        rows: machines,
    },
    // The economics band's own provider list, so the two cannot disagree about which plans work.
    providers: {
        heading: "What you do pay for, on either machine: your own AI plans.",
        accounts: landingContent.economics.accounts,
        points: landingContent.economics.points,
    },
    faq,
};
