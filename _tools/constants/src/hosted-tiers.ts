// THE HOSTED MACHINE LADDER: every rung the platform runs, what it costs us to run, and what it sells for. One module
// because the platform's config defaults, the public site's copy, the Billing page and the economics test all state
// these figures, and a number typed in two places rots in one of them silently.
//
// What money buys here is a machine and nothing else: no capability, extension, automation or shared workspace is
// behind a rung. Every price below is Fly's published rate for the default region (iad); they move, and when they do
// the ladder's own test says which rung stopped adding up.

/** Fly's published volume rate, USD per provisioned GB per 30 days, charged whether the machine is awake or not. */
export const FLY_VOLUME_GB_USD = 0.15;

// Stripe's card fee on one monthly charge, as a share plus a fixed amount; what reaches us is the price less both.
export const STRIPE_FEE_SHARE = 0.029;
export const STRIPE_FEE_USD = 0.3;

/**
 * What the free rung is allowed to cost us in its worst month, as a deliberate acquisition price rather than an
 * accident. A change to free's shape or hours that breaks through this is a business decision, and the test says so.
 */
export const FREE_TIER_MONTHLY_CEILING_USD = 3.5;

/** Every rung there is, cheapest first, as a tuple so a schema can take it and the type cannot drift from the list. */
export const HOSTED_TIER_IDS = ["free", "standard", "max"] as const;

export type HostedTierId = (typeof HOSTED_TIER_IDS)[number];

/**
 * The four numbers that make a machine, apart from which rung sold it. A machine row carries these rather than a tier
 * id alone: the two diverge mid-migration, and after any edit to the ladder below.
 */
export interface HostedShape {
    readonly cpuKind: "shared" | "performance";
    readonly cpus: number;
    readonly memoryMb: number;
    readonly volumeGb: number;
}

export interface HostedTier extends HostedShape {
    readonly id: HostedTierId;
    /** What the rung is called wherever a reader meets it. */
    readonly name: string;
    // Awake hours a month, enforced at wake; a sleeping machine spends none. Never 0: a rung with no ceiling cannot be
    // shown to pay for itself, and tierMonthlyCostUsd would read as free.
    readonly monthlyHours: number;
    // Display only, and what the configured Stripe Price is checked against at boot; Stripe is what actually charges.
    readonly priceUsd: number;
    // Fly's published price for this exact guest, USD per awake hour, iad. Every cost figure derives from it.
    readonly flyHourUsd: number;
}

/* THE LADDER. Two facts decided these shapes, and they are worth knowing before moving one:
 *
 * 1. Extra shared vCPUs are nearly free once you are paying for RAM. shared-cpu-8x costs $8.07 a month more than
 *    shared-cpu-4x; the step from 4 GB to 8 GB costs $41.52. So both paid rungs go wide on CPU, which is rounding
 *    error, and are careful with memory and disk, which are not.
 * 2. The free rung's cost is its disk, not its CPU. Forty awake hours on shared-cpu-4x is $1.32; its 10 GB volume is
 *    $1.50 a month standing, whether or not the person ever comes back. Dropping free to shared-cpu-2x would save
 *    $0.66 a month and halve the volume's ceiling (4000 IOPs and 16 MiB/s against 8000 and 32), which is exactly what
 *    a dependency install and an image pull wait on. */
export const HOSTED_TIERS: readonly HostedTier[] = [
    { id: "free", name: "Free", cpuKind: "shared", cpus: 4, memoryMb: 4096, volumeGb: 10, monthlyHours: 40, priceUsd: 0, flyHourUsd: 0.0329 },
    { id: "standard", name: "Standard", cpuKind: "shared", cpus: 8, memoryMb: 8192, volumeGb: 25, monthlyHours: 220, priceUsd: 20, flyHourUsd: 0.0657 },
    { id: "max", name: "Max", cpuKind: "shared", cpus: 8, memoryMb: 16_384, volumeGb: 50, monthlyHours: 320, priceUsd: 50, flyHourUsd: 0.1234 },
];

/** The rung a machine is on when nobody has paid for it; also every hosted machine's starting shape. */
export const FREE_TIER: HostedTier = HOSTED_TIERS[0] as HostedTier;

/** Every rung that is sold, cheapest first: what the Stripe prices are checked against and what the site prices. */
export const PAID_TIERS: readonly HostedTier[] = HOSTED_TIERS.filter((tier) => tier.priceUsd > 0);

/** A machine as a reader meets it, from the machine's own numbers: "8 shared vCPUs · 8 GB memory · 25 GB disk". */
export const hostedShapeLine = (shape: HostedShape): string =>
    `${shape.cpus} ${shape.cpuKind} vCPUs · ${shape.memoryMb / 1024} GB memory · ${shape.volumeGb} GB disk`;

export const isHostedTierId = (value: unknown): value is HostedTierId => HOSTED_TIER_IDS.includes(value as HostedTierId);

// Throws rather than answering undefined: the callers are a database column and a Stripe price, and an id neither
// recognises is corruption to be seen, not an absence to be handled.
export const hostedTier = (id: string): HostedTier => {
    const tier = HOSTED_TIERS.find((rung) => rung.id === id);
    if (tier === undefined) {
        throw new Error(`no hosted tier named ${id}; the ladder is ${HOSTED_TIER_IDS.join(", ")}`);
    }
    return tier;
};

/** What a month on this rung costs us if its owner spends every awake hour it allows, plus the disk, which always runs. */
export const tierMonthlyCostUsd = (tier: HostedTier): number => tier.monthlyHours * tier.flyHourUsd + tier.volumeGb * FLY_VOLUME_GB_USD;

/** What reaches us from one month's charge after the card fee; 0 for a rung nobody pays for. */
export const tierNetRevenueUsd = (tier: HostedTier): number => (tier.priceUsd === 0 ? 0 : tier.priceUsd * (1 - STRIPE_FEE_SHARE) - STRIPE_FEE_USD);

/**
 * Whether a machine moving from one rung to another needs a bigger disk. Fly volumes grow and never shrink, so a
 * downgrade keeps the disk it has: the alternative is a file-level copy, and the rule is one sentence instead.
 */
export const tierDiskGrows = (from: HostedTier, to: HostedTier): boolean => to.volumeGb > from.volumeGb;
