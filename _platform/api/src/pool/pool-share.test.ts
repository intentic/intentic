import { describe, expect, it } from "vitest";
import type { Config } from "../config.js";
import { computeMonth } from "./pool-share.js";

const config = { pool: { priceUsd: 20, creatorShare: 0.7 } } as Config;

const members = new Set([`m1`, `m2`]);

describe(`the pool math`, () => {
    it(`splits the pool by share of member active-days`, () => {
        const report = computeMonth(
            `2026-08`,
            [
                { extensionId: `acme.research`, userId: `m1` },
                { extensionId: `acme.research`, userId: `m2` },
                { extensionId: `acme.research`, userId: `m1` },
                { extensionId: `beta.replies`, userId: `m2` },
            ],
            members,
            2,
            config,
        );
        // 2 members × $20 = $40 gross; 70% pool = $28 = 2800 cents.
        expect(report.grossCents).toBe(4000);
        expect(report.poolCents).toBe(2800);
        expect(report.memberActiveDays).toBe(4);
        expect(report.extensions).toEqual([
            { extensionId: `acme.research`, activeDays: 3, share: 0.75, amountCents: 2100 },
            { extensionId: `beta.replies`, activeDays: 1, share: 0.25, amountCents: 700 },
        ]);
    });

    it(`counts non-member use separately and pays it nothing`, () => {
        const report = computeMonth(
            `2026-08`,
            [
                { extensionId: `acme.research`, userId: `m1` },
                { extensionId: `acme.research`, userId: `free-rider` },
                { extensionId: `beta.replies`, userId: `free-rider` },
            ],
            members,
            2,
            config,
        );
        expect(report.memberActiveDays).toBe(1);
        expect(report.otherActiveDays).toBe(2);
        // The whole pool goes to the one extension members actually used.
        expect(report.extensions).toEqual([{ extensionId: `acme.research`, activeDays: 1, share: 1, amountCents: 2800 }]);
    });

    it(`survives a month with members but no use at all`, () => {
        const report = computeMonth(`2026-08`, [], members, 2, config);
        expect(report.poolCents).toBe(2800);
        expect(report.extensions).toEqual([]);
    });

    it(`never pays out more than the pool, whatever the rounding`, () => {
        const rows = [`a.x`, `b.y`, `c.z`].flatMap((extensionId, index) =>
            Array.from({ length: index + 1 }, () => ({ extensionId, userId: `m1` })),
        );
        const report = computeMonth(`2026-08`, rows, new Set([`m1`]), 1, config);
        const paid = report.extensions.reduce((sum, row) => sum + row.amountCents, 0);
        expect(paid).toBeLessThanOrEqual(report.poolCents);
    });
});
