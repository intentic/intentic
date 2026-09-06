import type { FaqItem } from "./faq";
import { hosted, idleWeeks } from "./hosted";
import { landingContent } from "./landing";
import { APP_URL } from "./site";

/* /pricing. The product is free; the one paid thing is a hosted sandbox. "Pricing" is the highest-intent click
 * on a developer-tool site, and a visitor who finds no link assumes the price is hidden, so the page says
 * "free" where the question is asked (decision 2026-09-06, landing-blueprint.md). The landing page carries no
 * pricing band. Every figure comes from hosted.ts; none is typed here.
 *
 * THE QUESTION THAT SEPARATES THE COLUMNS IS WHOSE MACHINE THE AGENTS RUN ON, the same question the
 * positioning doc asks first. Money changes whose machine, never what you can do (docs/design/pricing-model.md). */

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
        note: "You pay your AI providers directly.",
    },
    {
        eyebrow: "Our machine",
        name: "Hosted",
        price: `Free, then $${hosted.priceUsd}`,
        priceNote: "a month per hosted sandbox via Stripe, cancel any time",
        includes: [
            `Free: one hosted sandbox, ${hosted.freeHours} awake hours a month, removed after ${idleWeeks} weeks unopened`,
            "On the plan: always on, no hour ceiling, never removed. Add a second hosted sandbox for another slot",
            `${hosted.cpus} shared vCPUs, ${hosted.memoryGb} GB memory, ${hosted.diskGb} GB disk`,
            "The same workspace and every feature, on either",
            "Sleeps while you are away; a sleeping machine spends no hours",
        ],
        cta: { label: "Start instantly", href: APP_URL },
        note: "Move the workspace to your own machine whenever you like; the plan is the only thing you cancel.",
    },
];

const faq: FaqItem[] = [
    {
        id: "is-any-of-it-paid",
        question: "Is any of it paid?",
        answer: [
            `The product is not: every sandbox, capability and shared workspace is free, with no tiers and no card, and all of intentic is MIT. The one paid thing is a hosted sandbox at $${hosted.priceUsd} a month each, for people who would rather not run a machine.`,
        ],
    },
    {
        id: "do-i-need-the-plan",
        question: "Do I need it to run agents?",
        answer: [
            `No. Agents run on your own AI accounts and your own machine. Only the hosted sandbox differs: free, it has ${hosted.freeHours} awake hours a month and is removed after ${idleWeeks} weeks unopened; on the plan it is always on.`,
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
    heading: "intentic is free. A machine of ours is the one thing we sell.",
    sub: "Every feature, capability and shared workspace is included on any number of sandboxes on your own hardware. Agents run on the AI plans you already pay for; we never meter tokens or add a markup.",
    columns,
    // The economics band's own provider list, so the two cannot disagree about which plans work.
    providers: {
        heading: "What you do pay for: your own AI plans.",
        accounts: landingContent.economics.accounts,
        points: landingContent.economics.points,
    },
    faq,
};
