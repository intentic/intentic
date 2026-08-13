import type { PrismaClient } from "@intentic-app/prisma";
import { describe, expect, it, vi } from "vitest";
import type { Config } from "../config.js";
import { creditStatus, refundCredits, spendCredits } from "./pool-credits.js";

const config = { pool: { dailyCredits: 100 } } as Config;
const NOW = new Date(`2026-08-10T12:00:00Z`);

// The meter over an in-memory (userId, day) map, with the same atomic semantics the real upsert has.
const fakePrisma = (seed = 0) => {
    const spent = new Map<string, number>([[`u1:2026-08-10`, seed]]);
    const key = (userId: string, day: string) => `${userId}:${day}`;
    const creditSpend = {
        findUnique: vi.fn(async ({ where }: { where: { userId_day: { userId: string; day: string } } }) => {
            const value = spent.get(key(where.userId_day.userId, where.userId_day.day));
            return value === undefined ? null : { credits: value };
        }),
        upsert: vi.fn(
            async ({
                where,
                create,
                update,
            }: {
                where: { userId_day: { userId: string; day: string } };
                create: { credits: number };
                update: { credits: { increment: number } };
            }) => {
                const k = key(where.userId_day.userId, where.userId_day.day);
                const next = (spent.get(k) ?? 0) + (spent.has(k) ? update.credits.increment : create.credits);
                spent.set(k, next);
                return { credits: next };
            },
        ),
        update: vi.fn(
            async ({ where, data }: { where: { userId_day: { userId: string; day: string } }; data: { credits: { decrement: number } } }) => {
                const k = key(where.userId_day.userId, where.userId_day.day);
                spent.set(k, (spent.get(k) ?? 0) - data.credits.decrement);
                return { credits: spent.get(k) };
            },
        ),
        updateMany: vi.fn(async ({ where, data }: { where: { userId: string; day: string; credits: { lt: number } }; data: { credits: number } }) => {
            const k = key(where.userId, where.day);
            if ((spent.get(k) ?? 0) < 0) {
                spent.set(k, data.credits);
            }
            return { count: 0 };
        }),
    };
    return { prisma: { creditSpend } as unknown as PrismaClient, spentToday: () => spent.get(`u1:2026-08-10`) ?? 0 };
};

describe(`the credit meter`, () => {
    it(`a fresh day is a full allowance`, async () => {
        const { prisma } = fakePrisma();
        expect(await creditStatus(prisma, config, `u1`, NOW)).toMatchObject({ allowance: 100, used: 0, remaining: 100 });
    });

    it(`spends atomically and refuses past the allowance from the post-increment count`, async () => {
        const { prisma } = fakePrisma(70);
        const first = await spendCredits(prisma, config, `u1`, 25, NOW);
        expect(first).toMatchObject({ allowed: true, used: 95, remaining: 5 });
        const second = await spendCredits(prisma, config, `u1`, 25, NOW);
        expect(second).toMatchObject({ allowed: false, remaining: 0 });
    });

    it(`a refund restores the meter and never drives it negative`, async () => {
        const { prisma, spentToday } = fakePrisma(40);
        await refundCredits(prisma, `u1`, 25, NOW);
        expect(spentToday()).toBe(15);
        await refundCredits(prisma, `u1`, 100, NOW);
        expect(spentToday()).toBe(0);
    });

    it(`the reset is the next UTC midnight`, async () => {
        const { prisma } = fakePrisma();
        expect((await creditStatus(prisma, config, `u1`, NOW)).resetsAt).toBe(`2026-08-11T00:00:00.000Z`);
    });
});
