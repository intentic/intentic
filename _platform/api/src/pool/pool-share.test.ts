import { describe, expect, it } from "vitest";
import type { Config } from "../config.js";
import { computeMonth, creditCents, poolUsd } from "./pool-share.js";

// $20/mo less $5 of infrastructure ⇒ a $15 pool; 1000 credits/day ⇒ a credit is worth 1500¢ / 30000 = 1/20¢.
const config = { pool: { priceUsd: 20, infraUsd: 5, creatorShare: 0.9, serviceShare: 0.9, dailyCredits: 1000, donationCredits: 200 } } as Config;

describe(`the pool math`, () => {
    it(`shares the membership after infrastructure, not the whole ticket`, () => {
        expect(poolUsd(config)).toBe(15);
    });

    it(`derives a credit's value from the pool rather than the price`, () => {
        expect(creditCents(config)).toBeCloseTo(1500 / 30000);
    });

    /* An infraUsd above the price is a misconfiguration, and the shape of the wrong answer matters: an empty
     * pool is merely nothing to share, while a negative one would read on the transparency page as creators
     * owing money back. */
    it(`clamps an infrastructure cost above the price to an empty pool`, () => {
        const broken = { pool: { ...config.pool, infraUsd: 50 } } as Config;
        expect(poolUsd(broken)).toBe(0);
        const report = computeMonth(`2026-08`, 2, broken, [], []);
        expect(report.infraCents).toBe(report.grossCents);
        expect(report.poolCents).toBe(0);
    });

    it(`pays each recipient a share of the credits it actually received`, () => {
        const report = computeMonth(
            `2026-08`,
            2,
            config,
            [
                { extensionId: `acme.research`, donors: 2, credits: 400 },
                { extensionId: `beta.replies`, donors: 1, credits: 200 },
            ],
            [{ slug: `demo-research`, publisher: `intentic`, runs: 3, credits: 120 }],
        );
        // 2 members × $20 = $40 gross, of which $10 is infrastructure; ceiling 90% of the $30 left = 2700¢.
        expect(report.grossCents).toBe(4000);
        expect(report.infraCents).toBe(1000);
        expect(report.poolCents).toBe(2700);
        // 400 credits × (1/20)¢ × 90% = 18¢; 200 → 9; 120 → 5.4 → 5.
        expect(report.extensions).toEqual([
            { extensionId: `acme.research`, donors: 2, credits: 400, earningsCents: 18 },
            { extensionId: `beta.replies`, donors: 1, credits: 200, earningsCents: 9 },
        ]);
        expect(report.services).toEqual([{ slug: `demo-research`, publisher: `intentic`, runs: 3, credits: 120, earningsCents: 5 }]);
        expect(report.paidCents).toBe(32);
    });

    it(`pays nothing for credits nobody spent: the pool is a ceiling, not a promise`, () => {
        const report = computeMonth(`2026-08`, 2, config, [], []);
        expect(report.poolCents).toBe(2700);
        expect(report.paidCents).toBe(0);
        expect(report.extensions).toEqual([]);
    });

    /* The sybil property the donation model was chosen for: a creator farming their own listing with a
     * bought membership can reclaim at most creatorShare of the credits that membership can ever spend:
     * strictly less than the $20 it cost, whatever they do. */
    it(`makes farming loss-making by arithmetic`, () => {
        const wholeAllowance = 30 * config.pool.dailyCredits;
        const report = computeMonth(`2026-08`, 1, config, [{ extensionId: `evil.farm`, donors: 1, credits: wholeAllowance }], []);
        /* The whole month's credits donated to yourself earn exactly the 90% ceiling: 1350¢ back on the 2000¢
         * paid, the gap now being the infrastructure as well as the share. Still loss-making, and what
         * actually makes self-dealing laborious is not this gap but the per-month donation dedupe, which caps
         * one membership at one donation per listing and so forces a farmer to publish a listing for every
         * 200 credits they want back. */
        expect(report.extensions[0]?.earningsCents).toBe(1350);
        expect(report.extensions[0]!.earningsCents).toBeLessThan(report.grossCents);
        expect(report.paidCents).toBeLessThanOrEqual(report.poolCents);
    });
});
