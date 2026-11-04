import { hostedTier, isHostedTierId, PAID_TIERS } from "@intentic/constants";
import { homePath, page, topPath } from "@intentic/sandbox-contract/app-routes";
import { hasSubscription, machineTier, managePlan, moveMachine, notOnSale, planState, setSlots, slotsLeftAt, subscribe, subscribed } from "../world/plan";
import { type PlatformRouter, refusePlatform } from "./serve";

// THE HOSTED PLAN, as the Billing page reads and changes it (world/plan.ts). Stripe cannot be reached from a web page, so
// the demo's checkout and portal are paid and done the moment they are asked for, and each answers with the address
// Stripe would send the browser back to: the demo's own Billing page, which then reads what the errand did.

// Where "Stripe" sends the browser back, as the platform names it (hosted-plan.orpc.ts `billingUrl`, `checkoutUrls`).
const appUrl = (path: string): string => `${window.location.origin}${import.meta.env.BASE_URL}${path.replace(/^\//, ``)}`;

// The account's Billing, in Home's frame where it needs no sandbox, as the platform's `billingUrl` builds it.
const BILLING = homePath(undefined, page.account(`billing`));
const BILLING_WELCOME = homePath(undefined, page.account(`billing`, { query: { plan: `welcome` } }));

// A rung a slot can be bought at, or the platform's own refusal for one it cannot.
const paidRung = (tier: string): string => {
    const why = notOnSale(tier);
    return why === undefined ? tier : refusePlatform(why);
};

export const hostedPlanAnswers = {
    // Plan's on/off answer decides whether Settings shows the Billing tab.
    state: () => planState(),
    // A second checkout on the plan would be a second subscription, which the platform refuses.
    checkout: (input) => {
        if (subscribed()) {
            return refusePlatform(`You are already on the hosted plan.`, 409);
        }
        const tier = paidRung(input?.tier ?? PAID_TIERS[0]?.id ?? `standard`);
        subscribe(tier);
        return { url: appUrl(input?.returnTo === undefined ? BILLING_WELCOME : topPath(`startHosted`, {}, { tier, plan: `welcome` })) };
    },
    portal: () => {
        if (!hasSubscription()) {
            return refusePlatform(`No plan to manage.`, 404);
        }
        managePlan();
        return { url: appUrl(BILLING) };
    },
    setSlots: ({ tier, quantity }) => {
        if (!subscribed()) {
            return refusePlatform(`Subscribe to the hosted plan first.`);
        }
        const refused = setSlots(paidRung(tier), quantity);
        return refused === undefined ? planState() : refusePlatform(refused);
    },
    // The slot must already be bought: money and machines are two separate, separately reversible acts.
    changeTier: async ({ sandboxId, tier }) => {
        if (!isHostedTierId(tier)) {
            return refusePlatform(`There is no machine called ${tier}.`);
        }
        const from = machineTier(sandboxId) ?? refusePlatform(`You have no hosted sandbox by that id.`, 404);
        if (from === tier) {
            return refusePlatform(`That sandbox is already on ${hostedTier(tier).name}.`);
        }
        if (slotsLeftAt(tier, sandboxId) <= 0) {
            return refusePlatform(hostedTier(tier).priceUsd === 0 ? `You have no free slot left.` : `Buy a ${hostedTier(tier).name} slot first.`);
        }
        return moveMachine(sandboxId, tier);
    },
} satisfies NonNullable<PlatformRouter[`hostedPlan`]>;
