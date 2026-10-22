import { FREE_TIER, type HostedTierId } from "@intentic/constants";
import type { HostedOffer } from "@intentic/api-contract";
import type { OrpcContext } from "../context.js";
import { requireUser } from "../guards.js";
import { hostedEnabled } from "./hosted/hosted.js";
import { arrivalTier, hostedArrivalFor, offeredMachines } from "./hosted/free-lane.js";
import { hostedPlanEnabled, hostedSlotUse, onHostedPlan } from "./hosted/plan/hosted-plan.js";
import { hostedArrivalBudget } from "./hosted/hosted-usage.js";
import { hostedCapacity } from "./hosted/hosted-capacity.js";
import { hostedSuspensionOf } from "./hosted/abuse/hosted-standing.js";
import { hostedRegionFor } from "./hosted/region.js";
import { hostedTierIn } from "./hosted/hosted-shape.js";
import { hoursOf } from "./hosted-refusals.js";

// The machine on offer for the chosen tier. A paid allocation is counted at its own tier and has its own hours;
// exhausted free hours and an occupied free allocation must not turn it into a refused free-machine request.
export const hostedOfferFor = async (context: OrpcContext, requestedTier?: HostedTierId): Promise<HostedOffer> => {
    const user = requireUser(context);
    if (!hostedEnabled(context.config)) {
        return { enabled: false, remaining: 0, projects: true };
    }
    const arrival = await hostedArrivalFor(context.prisma, context.config, user.id, requestedTier);
    const tier = arrival.lane === `needs-google` ? FREE_TIER.id : arrivalTier(arrival);
    const [slots, budget, plan, capacity, suspension] = await Promise.all([
        // Count only the tier this machine will actually occupy.
        hostedSlotUse(context.prisma, context.config, user.id, tier),
        // Included so the card states the ceiling before it's spent; omitted entirely when unmetered.
        hostedArrivalBudget(context.prisma, context.config, user.id),
        // Separate from unmetered: a ceiling-less platform is also unmetered, but its card must not claim an
        // unbought plan.
        hostedPlanEnabled(context.config) ? onHostedPlan(context.prisma, context.config, user.id) : Promise.resolve(false),
        // Fleet-wide capacity, not this account's allowance: a fresh account can still meet a full provider.
        // Region-aware, since stock the residency rule forbids this caller isn't stock to promise.
        hostedCapacity(context.prisma, context.config, hostedRegionFor(context.config.hosted, context.headers)),
        hostedSuspensionOf(context.prisma, context.config, user.id),
    ]);
    const offer: HostedOffer = {
        enabled: true,
        startJourney: true,
        projects: true,
        // A suspended account is offered nothing, whatever its slots say, nor is one that must link Google first; an
        // email-only account's own paid slot is offered as the one machine it can have (free-lane.ts).
        remaining: offeredMachines(arrival, suspension !== undefined, slots.left),
    };
    if (capacity.full) {
        offer.full = true;
    }
    if (tier !== FREE_TIER.id) {
        const allowance = hostedTierIn(context.config, tier).monthlyHours;
        offer.hours = { allowance, remaining: allowance };
    } else if (budget.metered) {
        offer.hours = hoursOf(budget);
    }
    if (plan) {
        offer.plan = true;
    }
    if (!plan && context.config.hosted.idleDays > 0 && context.config.hosted.idleWarnDays > 0) {
        offer.unopenedDays = context.config.hosted.idleDays;
    }
    if (suspension !== undefined) {
        offer.suspended = true;
    }
    if (arrival.lane === `needs-google`) {
        offer.needsGoogle = true;
    }
    return offer;
};
