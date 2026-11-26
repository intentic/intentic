import { hostedTier, isHostedTierId, PAID_TIERS } from "@intentic/constants";
import { homePath, insidePath, page, sandboxSegment, topPath } from "@intentic/sandbox-contract/app-routes";
import {
    changePlan,
    hasSubscription,
    machineTier,
    managePlan,
    moveMachine,
    notOnSale,
    planState,
    release,
    reserve,
    setSlots,
    subscribe,
    subscribed,
} from "../world/plan";
import { rowOf, sandboxRows } from "../world/sandboxRegistry";
import { type PlatformRouter, refusePlatform } from "./serve";

// THE ACCOUNT'S PLANS, as Billing, a sandbox's Plan card and the new sandbox's picker read and change them (world/plan.ts).
// Stripe cannot be reached from a web page, so the demo's checkout and portal are paid and done the moment they are asked
// for, and each answers with the address Stripe would send the browser back to: the demo's own page, which then reads
// what the errand did.

// Where "Stripe" sends the browser back, as the platform names it (hosted-plan.orpc.ts `billingUrl`, `checkoutUrls`).
const appUrl = (path: string): string => `${window.location.origin}${import.meta.env.BASE_URL}${path.replace(/^\//, ``)}`;

// The account's Billing, in Home's frame where it needs no sandbox, as the platform's `billingUrl` builds it.
const BILLING = homePath(undefined, page.account(`billing`));
const BILLING_WELCOME = homePath(undefined, page.account(`billing`, { query: { plan: `welcome` } }));

// A plan that can be bought here, or the platform's own refusal for one it cannot.
const paidRung = (tier: string): string => {
    const why = notOnSale(tier);
    return why === undefined ? tier : refusePlatform(why);
};

// Back to the sandbox a checkout upgraded, on its Overview, where its Plan card shows the restart.
const sandboxOverview = (sandboxId: string): string => {
    const row = rowOf(sandboxId);
    return row === undefined ? BILLING_WELCOME : insidePath(sandboxSegment(row, sandboxRows()), page.sandboxSettings(`overview`));
};

// Moves are a subscriber's: a first plan is bought through checkout.
const subscriber = (): void => {
    if (!subscribed()) {
        refusePlatform(`You have no paid plan yet; buy the first one on Stripe's page.`, 402);
    }
};

export const hostedPlanAnswers = {
    // Plan's on/off answer decides whether Settings shows the Billing tab.
    state: () => planState(),
    // A second checkout on the plan would be a second subscription, which the platform refuses.
    checkout: (input) => {
        if (subscribed()) {
            return refusePlatform(`You already pay for plans here; change this sandbox's plan instead.`, 409);
        }
        const tier = paidRung(input?.tier ?? PAID_TIERS[0]?.id ?? `standard`);
        const sandboxId = input?.sandboxId;
        if (sandboxId !== undefined && machineTier(sandboxId) === undefined) {
            return refusePlatform(`You have no cloud sandbox by that id.`, 404);
        }
        subscribe(tier, sandboxId);
        if (sandboxId !== undefined) {
            return { url: appUrl(sandboxOverview(sandboxId)) };
        }
        return { url: appUrl(input?.returnTo === undefined ? BILLING_WELCOME : topPath(`startHosted`, {}, { tier, plan: `welcome` })) };
    },
    portal: () => {
        if (!hasSubscription()) {
            return refusePlatform(`No plan to manage.`, 404);
        }
        managePlan();
        return { url: appUrl(BILLING) };
    },
    changePlan: ({ sandboxId, tier }) => {
        if (!isHostedTierId(tier)) {
            return refusePlatform(`There is no plan called ${tier}.`);
        }
        if (machineTier(sandboxId) === undefined) {
            return refusePlatform(`You have no cloud sandbox by that id.`, 404);
        }
        subscriber();
        if (hostedTier(tier).priceUsd > 0) {
            paidRung(tier);
        }
        const refused = changePlan(sandboxId, tier);
        return refused === undefined ? planState() : refusePlatform(refused);
    },
    reserve: ({ tier }) => {
        subscriber();
        reserve(paidRung(tier));
        return planState();
    },
    release: ({ tier }) => {
        subscriber();
        const refused = release(tier);
        return refused === undefined ? planState() : refusePlatform(refused);
    },
    // The earlier two-step form, still answered for an editor that sends it.
    setSlots: ({ tier, quantity }) => {
        subscriber();
        const refused = setSlots(paidRung(tier), quantity);
        return refused === undefined ? planState() : refusePlatform(refused);
    },
    changeTier: ({ sandboxId, tier }) => {
        if (!isHostedTierId(tier)) {
            return refusePlatform(`There is no plan called ${tier}.`);
        }
        const from = machineTier(sandboxId) ?? refusePlatform(`You have no cloud sandbox by that id.`, 404);
        if (from === tier) {
            return refusePlatform(`That sandbox is already on ${hostedTier(tier).name}.`);
        }
        return moveMachine(sandboxId, tier);
    },
} satisfies NonNullable<PlatformRouter[`hostedPlan`]>;
