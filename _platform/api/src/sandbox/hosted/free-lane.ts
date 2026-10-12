import { GOOGLE_REQUIRED_REASON } from "@intentic/api-contract";
import { FREE_TIER, type HostedTierId, PAID_TIERS } from "@intentic/constants";
import type { PrismaClient } from "@intentic/prisma";
import { ORPCError } from "@orpc/server";
import type { Config } from "../../config.js";
import { hasGoogleAccount } from "../../sign-in.js";
import { hostedSlotUse } from "./plan/hosted-plan.js";

/* THE FREE LANES NEED GOOGLE: the free hosted machine, the free trial and Repair spend intentic's own money on an account,
 * and their per-account limits are worth only what an account costs to make. A Google account costs a phone number and
 * Google's own abuse checks; an address that signs in with a mailed code costs a domain with a catch-all, or one of a
 * thousand throwaway inboxes. So an account that signs in only by email reaches these once it links Google, and can
 * otherwise buy a hosted machine or run its sandbox on its own computer. (2026-10-12) Chosen over keying the free
 * limits by a canonical address with a list of throwaway domains, which would have to be kept up and still leaves
 * catch-all domains open. */

// Where an account's next hosted machine arrives: on the free rung for an account with Google linked; straight onto a
// paid rung it holds an unused slot at for one that signs in only by email (the free rung is a free lane); nowhere until
// it links Google or buys one.
export type HostedArrival =
    | { readonly lane: `free` }
    | { readonly lane: `slot`; readonly tier: HostedTierId }
    | { readonly lane: `needs-google` };

export const hostedArrivalFor = async (
    prisma: Pick<PrismaClient, "account" | "hostedPlan" | "hostedMachine">,
    config: Config,
    userId: string,
): Promise<HostedArrival> => {
    if (await hasGoogleAccount(prisma, userId)) {
        return { lane: `free` };
    }
    // Cheapest rung first, so a machine never lands on a bigger slot than it has to.
    const uses = await Promise.all(PAID_TIERS.map((tier) => hostedSlotUse(prisma, config, userId, tier.id)));
    const open = PAID_TIERS.find((_tier, index) => (uses[index]?.left ?? 0) > 0);
    return open === undefined ? { lane: `needs-google` } : { lane: `slot`, tier: open.id };
};

// An arrival the gate let through: on the free rung, or onto a paid slot.
export type AdmittedArrival = Exclude<HostedArrival, { readonly lane: `needs-google` }>;

// The rung a machine arriving this way is built at.
export const arrivalTier = (arrival: AdmittedArrival): HostedTierId =>
    arrival.lane === `slot` ? arrival.tier : FREE_TIER.id;

// How many machines the hosted card offers: none to a suspended account or one that must link Google first, the one
// paid slot an email-only account arrives on, and otherwise what the free rung has left.
export const offeredMachines = (arrival: HostedArrival, suspended: boolean, freeLeft: number): number => {
    if (suspended || arrival.lane === `needs-google`) {
        return 0;
    }
    return arrival.lane === `slot` ? 1 : Math.max(0, freeLeft);
};

// Whether this account may spend a free lane: a Google account linked to it.
export const freeLaneOpen = (prisma: Pick<PrismaClient, "account">, userId: string): Promise<boolean> => hasGoogleAccount(prisma, userId);

// The refusal a free lane answers an email-only account with, its reason machine-readable so the editor offers the ways on.
export const googleRequired = (lane: string): ORPCError<`FORBIDDEN`, { reason: string }> =>
    new ORPCError(`FORBIDDEN`, {
        message: `${lane} needs a Google sign-in linked to this account: link Google in Settings, buy a hosted machine, or run the sandbox on your own computer`,
        data: { reason: GOOGLE_REQUIRED_REASON },
    });
