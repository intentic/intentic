import type { PrismaClient } from "@intentic-app/prisma";
import { describe, expect, it, vi } from "vitest";
import type { Config } from "../config.js";
import { buildLedger } from "./pool-ledger.js";

/* THE LEDGER IS THE PROMISE MADE CHECKABLE, so what is pinned here is what would make it a lie: an estimate
 * wearing the same name as a settled figure, and money that was earned but never reached anybody being folded
 * into a total that implies it did. */

const NOW = new Date(`2026-08-12T09:00:00Z`);

const config = {
    pool: {
        priceUsd: 20,
        creatorShare: 0.9,
        serviceShare: 0.9,
        dailyCredits: 1000,
        donationCredits: 200,
        payoutDayOfMonth: 15,
        minPayoutCents: 2500,
        claimWindowMonths: 12,
    },
} as Config;

const closedMonth = {
    month: `2026-07`,
    closedAt: new Date(`2026-08-01T00:05:00Z`),
    payableAt: new Date(`2026-08-15T00:00:00Z`),
    members: 3,
    grossCents: 5940,
    feeCents: 202,
    poolCents: 5400,
    earnedCents: 4000,
    sweptCents: 100,
    distributedCents: 4100,
    creatorShare: 0.9,
    serviceShare: 0.9,
    statements: [
        // Paid, in flight, owed-but-carried, never claimed, and expired — one of each, so every public total
        // has something behind it.
        { publisher: `paid-co`, amountCents: 2000, credits: 300, expiredAt: null, payout: { status: `paid` } },
        { publisher: `sending`, amountCents: 900, credits: 120, expiredAt: null, payout: { status: `pending` } },
        { publisher: `carried`, amountCents: 700, credits: 90, expiredAt: null, payout: null },
        { publisher: `nobody`, amountCents: 400, credits: 60, expiredAt: null, payout: null },
        { publisher: `gone`, amountCents: 100, credits: 10, expiredAt: new Date(`2026-08-01T00:00:00Z`), payout: null },
    ],
};

const fakePrisma = (closed: (typeof closedMonth)[] = []) =>
    ({
        donation: { findMany: vi.fn(async () => [{ extensionId: `acme.one`, credits: 300 }]) },
        serviceRun: { findMany: vi.fn(async () => []) },
        membership: { findMany: vi.fn(async () => [{ status: `active` }, { status: `active` }]) },
        poolMonth: { findMany: vi.fn(async () => closed) },
        publisherClaim: { findMany: vi.fn(async () => [{ publisher: `paid-co` }, { publisher: `sending` }, { publisher: `carried` }]) },
    }) as unknown as PrismaClient;

describe(`the public ledger`, () => {
    it(`never lets the open month's estimate pass as settled revenue`, async () => {
        const ledger = await buildLedger(fakePrisma(), config, NOW);
        const open = ledger.months[0];

        expect(open).toMatchObject({ month: `2026-08`, state: `open` });
        // 2 members × $20. Named an estimate, and NOT published under the same key a closed month uses.
        expect(open).toHaveProperty(`estimatedGrossCents`, 4000);
        expect(open).not.toHaveProperty(`grossCents`);
        expect(open).not.toHaveProperty(`feeCents`);
    });

    it(`publishes a closed month as settled, and says what became of every cent`, async () => {
        const ledger = await buildLedger(fakePrisma([closedMonth]), config, NOW);
        const closed = ledger.months[1] as unknown as Record<string, number | string>;

        expect(closed).toMatchObject({
            month: `2026-07`,
            state: `closed`,
            // What actually moved at Stripe, and what Stripe took — not members × price.
            grossCents: 5940,
            feeCents: 202,
            poolCents: 5400,
            earnedCents: 4000,
            sweptCents: 100,
            distributedCents: 4100,
        });
        // Every line accounted for by outcome, so "we pay 90%" cannot hide money that reached nobody.
        expect(closed).toMatchObject({ paidCents: 2000, pendingCents: 900, carriedCents: 700, unclaimedCents: 400, expiredCents: 100 });
        // And the five outcomes add up to what was distributed.
        const accounted = [`paidCents`, `pendingCents`, `carriedCents`, `unclaimedCents`, `expiredCents`].reduce(
            (sum, key) => sum + Number(closed[key]),
            0,
        );
        expect(accounted).toBe(closedMonth.distributedCents);
    });

    it(`states the payout rules beside the numbers they produced`, async () => {
        const ledger = await buildLedger(fakePrisma([closedMonth]), config, NOW);

        // The page explaining these and the platform applying them read the same source.
        expect(ledger).toMatchObject({ payoutDayOfMonth: 15, minPayoutCents: 2500, claimWindowMonths: 12, creatorShare: 0.9 });
    });
});
