import { describe, expect, it } from "vitest";
import type { Config } from "../config.js";
import { computeMonth, creditCents } from "./pool-share.js";

// $20/mo, 1000 credits/day ⇒ a credit is worth 2000¢ / 30000 = 1/15¢.
const config = { pool: { priceUsd: 20, creatorShare: 0.9, serviceShare: 0.9, dailyCredits: 1000, donationCredits: 200 } } as Config;

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
        // 2 members × $20 = $40 gross; ceiling 90% = 3600¢.
        expect(report.grossCents).toBe(4000);
        expect(report.poolCents).toBe(3600);
        // 400 credits × (1/15)¢ × 90% = 24¢; 200 → 12; 120 → 7.2 → 7.
        expect(report.extensions).toEqual([
            { extensionId: `acme.research`, donors: 2, credits: 400, earningsCents: 24 },
            { extensionId: `beta.replies`, donors: 1, credits: 200, earningsCents: 12 },
        ]);
        expect(report.services).toEqual([{ slug: `demo-research`, publisher: `intentic`, runs: 3, credits: 120, earningsCents: 7 }]);
        expect(report.paidCents).toBe(43);
    });

    it(`pays nothing for credits nobody spent — the pool is a ceiling, not a promise`, () => {
        const report = computeMonth(`2026-08`, 2, config, [], []);
        expect(report.poolCents).toBe(3600);
        expect(report.paidCents).toBe(0);
        expect(report.extensions).toEqual([]);
    });

    /* The sybil property the donation model was chosen for: a creator farming their own listing with a
     * bought membership can reclaim at most creatorShare of the credits that membership can ever spend —
     * strictly less than the $20 it cost, whatever they do. */
    it(`makes farming loss-making by arithmetic`, () => {
        const wholeAllowance = 30 * config.pool.dailyCredits;
        const report = computeMonth(`2026-08`, 1, config, [{ extensionId: `evil.farm`, donors: 1, credits: wholeAllowance }], []);
        /* The whole month's credits donated to yourself earn exactly the 90% ceiling — 1800¢ back on 2000¢
         * paid. Still loss-making, and note how much thinner the margin is at a 90% share than at 70%: what
         * actually makes self-dealing laborious is not this 200¢ gap but the per-month donation dedupe, which
         * caps one membership at one donation per listing and so forces a farmer to publish a listing for
         * every 200 credits they want back. */
        expect(report.extensions[0]?.earningsCents).toBe(1800);
        expect(report.extensions[0]!.earningsCents).toBeLessThan(report.grossCents);
        expect(report.paidCents).toBeLessThanOrEqual(report.poolCents);
    });
});
