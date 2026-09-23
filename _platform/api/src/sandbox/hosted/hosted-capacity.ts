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

/* WHAT THE PROVIDER SAID, kept beside WHEN, because the count never answered the only question an operator has.
 * Fly publishes no status code for an out-of-capacity refusal, so the wording is the entire diagnosis: an
 * allowance for this org is raised with Fly, while a region out of hardware is placed somewhere else instead,
 * and nothing about the size of the fleet tells the two apart. A fleet that held ten machines when Fly refused
 * and twelve an hour later was never at an org ceiling at all — but the alert had already said it might be,
 * named no region, and the log that knew both died with the container it was written in. */
interface ProviderRefusal {
    readonly at: number;
    readonly detail: string;
}

const providerFullAt = new Map<string, ProviderRefusal>();

// One refusal, as the alert and the fleet report read it.
export interface HostedRefusal {
    readonly region: string;
    // Fly's own words, verbatim.
    readonly detail: string;
}

// Fly refused a create for capacity in this region; remembered for a few minutes (hosted.ts, hosted-pool.ts,
// hosted-build.ts).
export const noteProviderAtCapacity = (region: string, detail: string, at: number = Date.now()): void => {
    providerFullAt.set(region, { at, detail });
};

// What to latch as the provider's words; a throw that carries none must not leave the alert quoting nothing.
export const providerWords = (error: unknown): string => (error instanceof Error ? error.message : `Fly refused to create a machine`);

// Tests reset this latch; nothing else should touch it.
export const forgetProviderCapacity = (): void => {
    providerFullAt.clear();
};

// Refusals still believed: one region if the caller names one, every region otherwise (health watch, canary,
// fleet report), since those ask whether placing machines is broken at all.
const liveRefusals = (region: string | undefined, now: number): HostedRefusal[] =>
    [...providerFullAt.entries()]
        .filter(([where, refusal]) => now - refusal.at < PROVIDER_FULL_MS && (region === undefined || where === region))
        .map(([where, refusal]) => ({ region: where, detail: refusal.detail }));

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
    // The refusals behind a `provider` reason, in the scope asked about; empty for every other reason.
    readonly refusals: readonly HostedRefusal[];
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
    const refusals = liveRefusals(region, now);
    const providerFull = refusals.length > 0;
    const capped = config.hosted.maxMachines > 0;
    // No ceiling and no refusal: skip the four queries this runs on every provision, refill, and build.
    if (!capped && !providerFull) {
        return { cap: 0, used: undefined, headroom: Number.POSITIVE_INFINITY, warm: 0, full: false, reason: undefined, refusals: [] };
    }
    const [machines, pooled, building, warm] = await Promise.all([
        prisma.hostedMachine.count(),
        prisma.hostedPoolMachine.count(),
        prisma.hostedBuild.count({ where: { state: BUILD_RUNNING } }),
/* NOT FILTERED BY IMAGE, and deliberately so now that a row's image is a DIGEST rather than the configured tag (hosted-image.ts). */
        prisma.hostedPoolMachine.count({
            where: { state: `ready`, ...(region === undefined ? {} : { region }) },
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
        // Only when the provider is the reason: at our own ceiling it has said nothing, and quoting a lapsed
        // refusal would date the alert rather than explain it.
        refusals: reason === `provider` ? refusals : [],
    };
};
