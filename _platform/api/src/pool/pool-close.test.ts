import type { PrismaClient } from "@intentic-app/prisma";
import { describe, expect, it, vi } from "vitest";
import type { Config } from "../config.js";
import { closeMonth, distribute, lastClosableMonth, monthWindow } from "./pool-close.js";
import type { StripeGateway } from "./pool-stripe.js";

/* THE CLOSE IS WHERE A PROMISE BECOMES A DEBT, so what is pinned here is everything a creator or an auditor
 * would call a broken promise: a month closing twice, a share moving under a settled month, revenue being
 * estimated when it was supposed to be read, expired money going somewhere it cannot be accounted for, and a
 * distribution whose lines do not add up to its total. */

const NOW = new Date(`2026-08-12T09:00:00Z`);

const config = {
    pool: {
        priceUsd: 20,
        creatorShare: 0.9,
        serviceShare: 0.9,
        dailyCredits: 1000,
        donationCredits: 200,
        payoutDayOfMonth: 15,
        claimWindowMonths: 12,
    },
} as Config;

interface Seed {
    donations?: { extensionId: string; credits: number }[];
    runs?: { credits: number; service: { slug: string; publisher: string } }[];
    memberships?: { status: string }[];
    statements?: { id: string; publisher: string; amountCents: number; expiresAt: Date; expiredAt: Date | null }[];
    claims?: { publisher: string }[];
    closed?: boolean;
}

// What the close writes, as the assertions read it.
interface WrittenMonth {
    month: string;
    members: number;
    grossCents: number;
    feeCents: number;
    earnedCents: number;
    sweptCents: number;
    distributedCents: number;
    creatorShare: number;
    serviceShare: number;
    payableAt: Date;
}
interface WrittenStatement {
    month: string;
    publisher: string;
    amountCents: number;
    credits: number;
    expiresAt: Date;
}

// Enough Prisma for the close: the four reads it makes, and a transaction that records what it was handed.
const fakePrisma = (seed: Seed = {}) => {
    const written: { month?: WrittenMonth; statements: WrittenStatement[]; expired: string[] } = { statements: [], expired: [] };
    const prisma = {
        poolMonth: {
            findUnique: vi.fn(async () => (seed.closed === true ? { id: `pm_1` } : null)),
            create: vi.fn((args: { data: WrittenMonth }) => {
                written.month = args.data;
                return args;
            }),
        },
        donation: { findMany: vi.fn(async () => seed.donations ?? []) },
        serviceRun: { findMany: vi.fn(async () => seed.runs ?? []) },
        membership: { findMany: vi.fn(async () => seed.memberships ?? []) },
        publisherClaim: { findMany: vi.fn(async () => seed.claims ?? []) },
        creatorStatement: {
            findMany: vi.fn(async ({ where }: { where: { expiresAt: { lte: Date } } }) =>
                (seed.statements ?? []).filter((row) => row.expiredAt === null && row.expiresAt <= where.expiresAt.lte),
            ),
            createMany: vi.fn((args: { data: WrittenStatement[] }) => {
                written.statements = args.data;
                return args;
            }),
            updateMany: vi.fn((args: { where: { id: { in: string[] } } }) => {
                written.expired = args.where.id.in;
                return args;
            }),
        },
        $transaction: vi.fn(async () => undefined),
    };
    return { prisma: prisma as unknown as PrismaClient, written };
};

const gatewayWith = (settled: { grossCents: number; feeCents: number } | Error): StripeGateway =>
    ({
        settledRevenue: vi.fn(async () => {
            if (settled instanceof Error) {
                throw settled;
            }
            return settled;
        }),
    }) as unknown as StripeGateway;

describe(`month arithmetic`, () => {
    it(`windows a month half-open in UTC, and only ever closes a month that is over`, () => {
        expect(monthWindow(`2026-07`)).toEqual({ from: new Date(`2026-07-01T00:00:00Z`), to: new Date(`2026-08-01T00:00:00Z`) });
        // December → January is the rollover a naive month+1 gets wrong.
        expect(monthWindow(`2026-12`).to).toEqual(new Date(`2027-01-01T00:00:00Z`));
        expect(lastClosableMonth(NOW)).toBe(`2026-07`);
        expect(lastClosableMonth(new Date(`2026-01-04T00:00:00Z`))).toBe(`2025-12`);
    });

    it(`distributes every cent, by largest remainder`, () => {
        const shares = [
            { publisher: `a`, amountCents: 100, credits: 0 },
            { publisher: `b`, amountCents: 100, credits: 0 },
            { publisher: `c`, amountCents: 100, credits: 0 },
        ];
        const split = distribute(10, shares);

        // 10 across three equal earners cannot be equal — but it must still be exactly 10.
        expect(split.reduce((sum, value) => sum + value, 0)).toBe(10);
        expect(split).toEqual([4, 3, 3]);
    });

    it(`distributes nothing when there is nothing to distribute or nobody to receive it`, () => {
        expect(distribute(0, [{ publisher: `a`, amountCents: 100, credits: 0 }])).toEqual([0]);
        expect(distribute(500, [])).toEqual([]);
        // A month whose earners all rounded to zero has no basis to split by — and must not divide by it.
        expect(distribute(500, [{ publisher: `a`, amountCents: 0, credits: 0 }])).toEqual([0]);
    });
});

describe(`closing a month`, () => {
    it(`freezes the settled revenue, the shares and the payable date, and folds both lanes into one line per publisher`, async () => {
        const { prisma, written } = fakePrisma({
            donations: [
                { extensionId: `acme.one`, credits: 200 },
                { extensionId: `acme.two`, credits: 200 },
                { extensionId: `other.one`, credits: 200 },
            ],
            runs: [{ credits: 100, service: { slug: `acme.research`, publisher: `acme` } }],
            memberships: [{ status: `active` }, { status: `active` }, { status: `canceled` }],
        });

        const outcome = await closeMonth(`2026-07`, {
            prisma,
            config,
            gateway: gatewayWith({ grossCents: 3980, feeCents: 145 }),
            now: () => NOW,
        });

        expect(outcome.closed).toBe(true);
        // Published revenue is what Stripe settled, NOT members × price — the two differ here on purpose.
        expect(written.month).toMatchObject({
            month: `2026-07`,
            members: 2,
            grossCents: 3980,
            feeCents: 145,
            creatorShare: 0.9,
            serviceShare: 0.9,
            payableAt: new Date(`2026-08-15T00:00:00Z`),
        });
        // acme earned through both lanes and is owed one amount; the publisher, not the extension id, is the payee.
        expect(written.statements.map((row) => row.publisher)).toEqual([`acme`, `other`]);
        expect(written.statements).toHaveLength(2);
        // Twelve months from the end of the month earned.
        expect(written.statements[0]?.expiresAt).toEqual(new Date(`2027-08-01T00:00:00Z`));
    });

    it(`refuses to close twice`, async () => {
        const { prisma, written } = fakePrisma({ closed: true, donations: [{ extensionId: `acme.one`, credits: 200 }] });

        const outcome = await closeMonth(`2026-07`, { prisma, config, gateway: gatewayWith({ grossCents: 1, feeCents: 0 }), now: () => NOW });

        expect(outcome).toEqual({ month: `2026-07`, closed: false, reason: `already closed` });
        expect(written.month).toBeUndefined();
    });

    it(`aborts rather than publishing an estimated revenue figure`, async () => {
        const { prisma, written } = fakePrisma({ donations: [{ extensionId: `acme.one`, credits: 200 }] });

        const outcome = await closeMonth(`2026-07`, { prisma, config, gateway: gatewayWith(new Error(`stripe down`)), now: () => NOW });

        expect(outcome.closed).toBe(false);
        expect(outcome.reason).toContain(`settled revenue unreadable`);
        // Nothing frozen: the month stays open and the next tick retries.
        expect(written.month).toBeUndefined();
        expect(written.statements).toEqual([]);
    });

    it(`sweeps expired UNCLAIMED money into this month's earners, and leaves claimed money alone`, async () => {
        const longAgo = new Date(`2025-07-01T00:00:00Z`);
        const { prisma, written } = fakePrisma({
            donations: [{ extensionId: `acme.one`, credits: 200 }],
            claims: [{ publisher: `stillhere` }],
            statements: [
                { id: `s1`, publisher: `vanished`, amountCents: 500, expiresAt: longAgo, expiredAt: null },
                // Claimed: owed until paid, however long that takes.
                { id: `s2`, publisher: `stillhere`, amountCents: 900, expiresAt: longAgo, expiredAt: null },
            ],
        });

        const outcome = await closeMonth(`2026-07`, { prisma, config, gateway: gatewayWith({ grossCents: 2000, feeCents: 60 }), now: () => NOW });

        expect(outcome.sweptCents).toBe(500);
        expect(written.expired).toEqual([`s1`]);
        // The whole swept amount lands on the one earner, on top of what it earned itself.
        const acme = written.statements.find((row) => row.publisher === `acme`);
        expect(acme?.amountCents).toBe(Number(written.month?.[`earnedCents`]) + 500);
        expect(written.month).toMatchObject({ sweptCents: 500, distributedCents: acme?.amountCents });
    });

    it(`holds expired money back when the closing month has nobody to give it to`, async () => {
        const { prisma, written } = fakePrisma({
            statements: [{ id: `s1`, publisher: `vanished`, amountCents: 500, expiresAt: new Date(`2025-07-01T00:00:00Z`), expiredAt: null }],
        });

        const outcome = await closeMonth(`2026-07`, { prisma, config, gateway: gatewayWith({ grossCents: 0, feeCents: 0 }), now: () => NOW });

        // A month with no earners would make the money disappear; it stays claimable for a close that can pass it on.
        expect(outcome.closed).toBe(true);
        expect(outcome.sweptCents).toBe(0);
        expect(written.expired).toEqual([]);
        expect(written.statements).toEqual([]);
    });

    it(`closes an empty month rather than skipping it`, async () => {
        const { prisma, written } = fakePrisma({});

        const outcome = await closeMonth(`2026-07`, { prisma, config, gateway: gatewayWith({ grossCents: 0, feeCents: 0 }), now: () => NOW });

        // A month nobody earned in is still a closed month — skipping it would leave it open forever, and the
        // catch-up loop would retry it every day for as long as the platform runs.
        expect(outcome).toMatchObject({ month: `2026-07`, closed: true, statements: 0, distributedCents: 0 });
        expect(written.month).toMatchObject({ month: `2026-07`, earnedCents: 0, distributedCents: 0 });
    });
});
