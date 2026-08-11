import { describe, expect, it } from "vitest";
import type { Config } from "../config.js";
import { computeMonth, creditCents } from "./pool-share.js";

// $20/mo, 1000 credits/day ⇒ a credit is worth 2000¢ / 30000 = 1/15¢.
const config = { pool: { priceUsd: 20, creatorShare: 0.7, serviceShare: 0.7, dailyCredits: 1000, donationCredits: 200 } } as Config;

describe(`the pool math`, () => {
    it(`derives a credit's value from the published numbers`, () => {
        expect(creditCents(config)).toBeCloseTo(2000 / 30000);
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
        // 2 members × $20 = $40 gross; ceiling 70% = 2800¢.
        expect(report.grossCents).toBe(4000);
        expect(report.poolCents).toBe(2800);
        // 400 credits × (1/15)¢ × 70% = 18.66…¢ → 18; 200 → 9; 120 → 5.
        expect(report.extensions).toEqual([
            { extensionId: `acme.research`, donors: 2, credits: 400, earningsCents: 18 },
            { extensionId: `beta.replies`, donors: 1, credits: 200, earningsCents: 9 },
        ]);
        expect(report.services).toEqual([{ slug: `demo-research`, publisher: `intentic`, runs: 3, credits: 120, earningsCents: 5 }]);
        expect(report.paidCents).toBe(32);
    });

    it(`pays nothing for credits nobody spent — the pool is a ceiling, not a promise`, () => {
        const report = computeMonth(`2026-08`, 2, config, [], []);
        expect(report.poolCents).toBe(2800);
        expect(report.paidCents).toBe(0);
        expect(report.extensions).toEqual([]);
    });

    /* The sybil property the donation model was chosen for: a creator farming their own listing with a
     * bought membership can reclaim at most creatorShare of the credits that membership can ever spend —
     * strictly less than the $20 it cost, whatever they do. */
    it(`makes farming loss-making by arithmetic`, () => {
        const wholeAllowance = 30 * config.pool.dailyCredits;
        const report = computeMonth(`2026-08`, 1, config, [{ extensionId: `evil.farm`, donors: 1, credits: wholeAllowance }], []);
        // The whole month's credits donated to yourself earn exactly the 70% ceiling — 1400¢ back on 2000¢ paid.
        expect(report.extensions[0]?.earningsCents).toBe(1400);
        expect(report.extensions[0]!.earningsCents).toBeLessThan(report.grossCents);
        expect(report.paidCents).toBeLessThanOrEqual(report.poolCents);
    });
});
