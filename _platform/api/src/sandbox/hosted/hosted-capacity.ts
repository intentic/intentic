import type { PrismaClient } from "@intentic/prisma";
import type { Config } from "../../config.js";

// Whether a machine is left to give, checked before anything is spent. Two signals: the platform's own count, and the
// provider's own refusal (latched briefly, per region). Warm stock outranks both: claiming one creates nothing, so
// `full` means nothing to hand over and nothing buildable.

// State hosted-build.ts writes on a running builder; duplicated here rather than imported to avoid a cycle.
const BUILD_RUNNING = `building`;

// Thrown where a machine would have been created; its own class so the route can answer it in plain words instead of a
// gateway error.
export class HostedAtCapacity extends Error {}

// What a person reads: no provider named, and it points to the way through (their own computer).
export const AT_CAPACITY_MESSAGE = `we're out of machines right now — every one we run is in use. Set your sandbox up on your own computer in the meantime, or check back a little later.`;

// How long a provider refusal is believed, per region (an org allowance is global; a region's hardware is not).
const PROVIDER_FULL_MS = 5 * 60 * 1000;
const providerFullAt = new Map<string, number>();

// Fly refused a create for capacity in this region; remembered for a few minutes (hosted.ts, hosted-pool.ts,
// hosted-build.ts).
export const noteProviderAtCapacity = (region: string, at: number = Date.now()): void => {
    providerFullAt.set(region, at);
};

// Tests reset this latch; nothing else should touch it.
export const forgetProviderCapacity = (): void => {
    providerFullAt.clear();
};

// Is the provider refusing right now: one region if the caller names one, any region otherwise (health watch, canary,
// fleet report), since those ask whether placing machines is broken at all.
const providerRefusing = (region: string | undefined, now: number): boolean => {
    const live = (at: number): boolean => now - at < PROVIDER_FULL_MS;
    if (region === undefined) {
        return [...providerFullAt.values()].some(live);
    }
    const at = providerFullAt.get(region);
    return at !== undefined && live(at);
};

export interface HostedCapacity {
    // The configured ceiling; 0 when the platform imposes none of its own.
    readonly cap: number;
    // Machines held on the provider; undefined when no ceiling or refusal makes it worth asking.
    readonly used: number | undefined;
    // How many more may be created; infinite when no ceiling is configured and the provider hasn't refused.
    readonly headroom: number;
    // Claimable warm stock (in the named region, if any); outranks the count since handing it over creates nothing.
    readonly warm: number;
    // Nothing to hand over and nothing may be built; the one field every caller reads.
    readonly full: boolean;
    // Why: the platform's own ceiling, or the provider's refusal.
    readonly reason: "cap" | "provider" | undefined;
}

// Room left under the platform's own ceiling, ignoring warm stock: the pool asks 'may I build one more', not 'can
// somebody be served', and building is what stock is made of.
export const hostedHeadroom = (config: Config, used: number): number =>
    config.hosted.maxMachines > 0 ? Math.max(0, config.hosted.maxMachines - used) : Number.POSITIVE_INFINITY;

// The lane's capacity right now. `region` narrows warm stock to what a caller could actually be served from
// (residency), mirroring the same filters hosted.ts's claim uses.
export const hostedCapacity = async (
    prisma: PrismaClient,
    config: Config,
    region?: string,
    now: number = Date.now(),
): Promise<HostedCapacity> => {
    const providerFull = providerRefusing(region, now);
    const capped = config.hosted.maxMachines > 0;
    // No ceiling and no refusal: skip the four queries this runs on every provision, refill, and build.
    if (!capped && !providerFull) {
        return { cap: 0, used: undefined, headroom: Number.POSITIVE_INFINITY, warm: 0, full: false, reason: undefined };
    }
    const [machines, pooled, building, warm] = await Promise.all([
        prisma.hostedMachine.count(),
        prisma.hostedPoolMachine.count(),
        prisma.hostedBuild.count({ where: { state: BUILD_RUNNING } }),
        /* NOT FILTERED BY IMAGE, and deliberately so now that a row's image is a DIGEST rather than the
         * configured tag (hosted-image.ts). Matching the tag here would count every row as drift and report a
         * stocked pool as empty; matching the digest would mean resolving it, and this function is on the path
         * that REFUSES a full fleet — which must not make an outbound call before saying no. Reconcile destroys
         * drifted rows every tick, so a `ready` row with an identity is current except inside one tick, and in
         * that window over-counting only makes the lane more willing to try. The claim itself is exact. */
        prisma.hostedPoolMachine.count({
            where: { state: `ready`, NOT: { token: `` }, ...(region === undefined ? {} : { region }) },
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
        // Stock already exists: while any is warm, the lane serves the next arrival regardless of the counter or
        // provider.
        full: reason !== undefined && warm === 0,
        reason,
    };
};
