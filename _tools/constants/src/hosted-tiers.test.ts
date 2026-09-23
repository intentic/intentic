import {
    FREE_TIER,
    FREE_TIER_MONTHLY_CEILING_USD,
    HOSTED_TIER_IDS,
    HOSTED_TIERS,
    hostedTier,
    isHostedTierId,
    tierDiskGrows,
    tierMonthlyCostUsd,
    tierNetRevenueUsd,
} from "./hosted-tiers.js";

// The ladder judged by shape rather than by name: every assertion below reads HOSTED_TIERS, so a fourth rung added
// tomorrow is held to the same rules without this file being touched. What it guards is the one property a price list
// can lose silently — a rung whose worst month costs more than it charges.

describe("no rung can lose money at its own ceiling", () => {
    for (const tier of HOSTED_TIERS.filter((rung) => rung.priceUsd > 0)) {
        test(`${tier.id} pays for itself with every allowed hour spent`, () => {
            // Not 0: a paid rung with no ceiling cannot be shown to pay for anything, and its cost would read as disk alone.
            expect(tier.monthlyHours).toBeGreaterThan(0);
            expect(tierMonthlyCostUsd(tier)).toBeLessThanOrEqual(tierNetRevenueUsd(tier));
        });
    }
});

test("the free rung's worst month is the acquisition price it was chosen to be", () => {
    expect(tierNetRevenueUsd(FREE_TIER)).toBe(0);
    expect(tierMonthlyCostUsd(FREE_TIER)).toBeLessThanOrEqual(FREE_TIER_MONTHLY_CEILING_USD);
});

test("only the first rung is free, and it is the one a machine starts on", () => {
    expect(HOSTED_TIERS.filter((tier) => tier.priceUsd === 0)).toEqual([FREE_TIER]);
    expect(FREE_TIER.id).toBe("free");
});

test("the ladder climbs: nothing a rung sells is smaller than the rung below it", () => {
    const climbs = (of: (tier: (typeof HOSTED_TIERS)[number]) => number): number[] => HOSTED_TIERS.map(of);
    for (const measure of [
        { name: "priceUsd", values: climbs((tier) => tier.priceUsd) },
        { name: "cpus", values: climbs((tier) => tier.cpus) },
        { name: "memoryMb", values: climbs((tier) => tier.memoryMb) },
        { name: "volumeGb", values: climbs((tier) => tier.volumeGb) },
        { name: "monthlyHours", values: climbs((tier) => tier.monthlyHours) },
        { name: "flyHourUsd", values: climbs((tier) => tier.flyHourUsd) },
    ]) {
        expect({ [measure.name]: measure.values }).toEqual({ [measure.name]: [...measure.values].toSorted((a, b) => a - b) });
    }
    // Price alone must climb strictly, since two rungs at one price are one rung with two names.
    expect(new Set(climbs((tier) => tier.priceUsd)).size).toBe(HOSTED_TIERS.length);
});

test("the id list and the ladder are the same rungs in the same order", () => {
    expect(HOSTED_TIERS.map((tier) => tier.id)).toEqual([...HOSTED_TIER_IDS]);
});

test("a rung is found by id, and an id off the ladder names itself", () => {
    expect(hostedTier("max")).toBe(HOSTED_TIERS.at(-1));
    expect(() => hostedTier("enterprise")).toThrow(`no hosted tier named enterprise; the ladder is free, standard, max`);
    expect(isHostedTierId("standard")).toBe(true);
    expect(isHostedTierId("enterprise")).toBe(false);
});

test("a downgrade never grows the disk, and an upgrade to more disk does", () => {
    expect(tierDiskGrows(hostedTier("free"), hostedTier("standard"))).toBe(true);
    expect(tierDiskGrows(hostedTier("max"), hostedTier("free"))).toBe(false);
    expect(tierDiskGrows(hostedTier("max"), hostedTier("max"))).toBe(false);
});

test("the cost of a month is the hours at the cap plus the disk, which runs whether or not the machine does", () => {
    // Free, by hand: 40 h at $0.0329 is $1.316, and 10 GB at $0.15 is $1.50.
    expect(tierMonthlyCostUsd(FREE_TIER)).toBeCloseTo(2.816, 3);
    // $20 less Stripe's 2.9% and 30 cents.
    expect(tierNetRevenueUsd(hostedTier("standard"))).toBeCloseTo(19.12, 2);
});
