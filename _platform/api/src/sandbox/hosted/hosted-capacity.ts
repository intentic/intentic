import type { PrismaClient } from "@intentic/prisma";
import type { Config } from "../../config.js";

/* IS THERE A MACHINE LEFT TO GIVE, asked before anybody presses anything.
 *
 * The hosted lane rests on somebody else's finite pool. A Fly org has a machine allowance (ours is a hundred),
 * a region has real hardware in it, and the provider enforces both the only way it can: by refusing a create.
 * Everything above that refusal used to read it as a fault. The route answered BAD_GATEWAY carrying Fly's own
 * sentence, the setup card printed it under "Couldn't start a machine for you right now" with a Try again
 * button that could not work, and a browser arrival meets all of that WITHOUT HAVING CLICKED ANYTHING, because
 * a browser's first screen provisions on its own (setupArrival.ts). The first thing a new account would see, on
 * the day we fill up, is our provider's internal vocabulary and a button that fails again.
 *
 * A full fleet is not a fault. It is a fact with a remedy, and the remedy is on the same screen: the other rung
 * runs the sandbox on the reader's own computer, today, with no waiting on us. So this module answers one
 * question — is the lane full — early enough that the page can say so instead of failing.
 *
 * TWO WAYS TO KNOW IT, and both are needed:
 *   • THE PLATFORM'S OWN COUNT against `HOSTED_MAX_MACHINES`, which is exact, free (its own rows), and knows
 *     BEFORE the provider is called. Set the knob a shade under the org's real allowance and nobody ever meets
 *     the provider's refusal at all.
 *   • THE PROVIDER'S REFUSAL, latched for a few minutes when Fly answers a create with a capacity error
 *     (fly.ts's isFlyCapacity). This is what makes an unconfigured platform degrade gracefully anyway, and it
 *     covers the drift the count cannot see: a machine created outside the platform, an allowance quietly
 *     lowered, a region that is out of hardware while the org still has room.
 *
 * WARM STOCK OUTRANKS BOTH, and this is the part worth being careful about: claiming a machine that already
 * exists creates nothing. A fleet sitting exactly on its ceiling with two warm machines in it can still serve
 * the next two arrivals in seconds, and refusing them because a counter says "full" would strand people in
 * front of the one lane that was, at that moment, working perfectly. So `full` means there is nothing to hand
 * over AND nothing may be built — never merely that the count is at its ceiling. */

/* The state word hosted-build.ts writes on a builder that is still running. A builder is a real machine inside
 * a sandbox's app for the minutes of one build, so it spends the same allowance and has to be counted.
 * Repeated here rather than imported: hosted-build.ts asks THIS module whether it may create one at all, and a
 * cycle between the two would cost more than one duplicated word. */
const BUILD_RUNNING = `building`;

/* THE LANE IS FULL, thrown where a machine would have been created. Its own class for the same reason
 * HostedAlreadyProvisioned has one: the route above answers it differently from every other provisioning
 * failure — a refusal in plain words rather than a gateway error — and string-matching a provider's message to
 * find that out is how the wrong screen gets shown. */
export class HostedAtCapacity extends Error {}

/* WHAT A PERSON READS. One sentence, no provider in it, and it names the way through rather than asking anyone
 * to wait on us: the rung beside this one sets a sandbox up on their own computer and never had a limit.
 * Deliberately not "try again later" alone, which is a page telling somebody to keep pressing a button. */
export const AT_CAPACITY_MESSAGE = `we're out of machines right now — every one we run is in use. Set your sandbox up on your own computer in the meantime, or check back a little later.`;

/* HOW LONG THE PROVIDER'S OWN REFUSAL IS BELIEVED. Long enough that a queue of arrivals does not each spend a
 * failed round-trip discovering the same thing, short enough that a raised quota, a destroyed machine or a
 * region coming back is picked up without a deploy. Kept in memory rather than in a row: it is a hint that
 * makes the page honest a few seconds sooner, never the enforcement (the provider is that), and a replica that
 * has not seen a refusal yet simply asks Fly and finds out — gracefully, which is the whole point of the rest
 * of this file.
 *
 * PER REGION, because that is the shape of the fact. An org allowance is global and a region running out of
 * hardware is not, and the platform places machines in two regions on purpose: a European sandbox stays in the
 * EEA or the privacy policy's residency promise breaks. Latched globally, one bad afternoon in Stockholm would
 * tell every reader in Ashburn that we are out of machines while their region had ninety of them free. */
const PROVIDER_FULL_MS = 5 * 60 * 1000;
const providerFullAt = new Map<string, number>();

// Fly refused a create for capacity in this region: remember it for the next few minutes (hosted.ts,
// hosted-pool.ts, hosted-build.ts). The region is always known at the call site — every create names one.
export const noteProviderAtCapacity = (region: string, at: number = Date.now()): void => {
    providerFullAt.set(region, at);
};

// Tests reset the latch; nothing else has any business touching it.
export const forgetProviderCapacity = (): void => {
    providerFullAt.clear();
};

/* Is the provider refusing right now: for one region when the caller has one (a provision, a build, a pool
 * tick), and for ANY region when it does not (the health watch, the canary, the fleet report). The second
 * reading is deliberately the cautious one: those three are asking "is something wrong with placing machines",
 * and one region that cannot take any is worth an operator's attention and worth not spending a canary on. */
const providerRefusing = (region: string | undefined, now: number): boolean => {
    const live = (at: number): boolean => now - at < PROVIDER_FULL_MS;
    if (region === undefined) {
        return [...providerFullAt.values()].some(live);
    }
    const at = providerFullAt.get(region);
    return at !== undefined && live(at);
};

export interface HostedCapacity {
    // The configured ceiling, 0 when the platform imposes none of its own.
    readonly cap: number;
    /* Machines this platform holds on the provider: people's sandboxes, warm stock, builders in flight.
     * `undefined` when nothing needed counting — no ceiling configured and no refusal to explain — because
     * then there is no question the number answers and no reason to ask the database it comes from. */
    readonly used: number | undefined;
    // How many more it may create. Infinite where no ceiling is configured and the provider has not refused.
    readonly headroom: number;
    // Claimable warm machines (in the region asked about, when one was named): stock that can be handed over
    // without creating anything, which is why it outranks the count.
    readonly warm: number;
    // Nothing to hand over and nothing may be built. The one field every surface reads.
    readonly full: boolean;
    // Why, for the log line and the operator's mail: our own ceiling, or the provider's refusal.
    readonly reason: "cap" | "provider" | undefined;
}

/* How much room is left under the platform's own ceiling. Separate from `full` because the pool asks a
 * different question from the wizard: not "can somebody be served" but "may I build one more", and the answer
 * to the second must ignore warm stock entirely, since building is what warm stock is made of. */
export const hostedHeadroom = (config: Config, used: number): number =>
    config.hosted.maxMachines > 0 ? Math.max(0, config.hosted.maxMachines - used) : Number.POSITIVE_INFINITY;

/* The lane's capacity right now. `region` narrows the warm-stock half to the one region a caller could
 * actually be served from — an Ashburn machine is no use to the EEA caller the residency promise covers
 * (hosted.ts's claim filters on exactly this), so counting stock globally would promise a machine that the
 * claim is not allowed to hand over. The filters mirror the claim's: stock on the current image, with an
 * identity, ready to be taken. */
export const hostedCapacity = async (
    prisma: PrismaClient,
    config: Config,
    region?: string,
    now: number = Date.now(),
): Promise<HostedCapacity> => {
    const providerFull = providerRefusing(region, now);
    const capped = config.hosted.maxMachines > 0;
    /* NOTHING TO ENFORCE AND NOTHING REFUSED, which is every tick on a platform that has not set a ceiling
     * (the default, and the right one for a self-hoster whose org allowance is theirs to know). There is no
     * question the counts would answer, so they are not made: provisioning, the pool's refill and every
     * environment build ask this on their hot path, and a platform with no ceiling should not pay four
     * queries per machine to be told it has room. */
    if (!capped && !providerFull) {
        return { cap: 0, used: undefined, headroom: Number.POSITIVE_INFINITY, warm: 0, full: false, reason: undefined };
    }
    const [machines, pooled, building, warm] = await Promise.all([
        prisma.hostedMachine.count(),
        prisma.hostedPoolMachine.count(),
        prisma.hostedBuild.count({ where: { state: BUILD_RUNNING } }),
        prisma.hostedPoolMachine.count({
            where: { state: `ready`, image: config.hosted.image, NOT: { token: `` }, ...(region === undefined ? {} : { region }) },
        }),
    ]);
    const used = machines + pooled + building;
    const headroom = hostedHeadroom(config, used);
    const reason = headroom === 0 ? (`cap` as const) : providerFull ? (`provider` as const) : undefined;
    return {
        cap: config.hosted.maxMachines,
        used,
        headroom: providerFull ? 0 : headroom,
        warm,
        // Stock is a machine that already exists: while there is any, the lane can serve the next arrival
        // whatever the counter or the provider says about NEW ones.
        full: reason !== undefined && warm === 0,
        reason,
    };
};
