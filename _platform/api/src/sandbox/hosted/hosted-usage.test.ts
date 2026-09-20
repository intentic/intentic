import { FREE_TIER, hostedTier } from "@intentic/constants";
import type { PrismaClient } from "@intentic/prisma";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../../config.js";
import {
    hostedArrivalBudget,
    hostedBudgetOf,
    hostedOwnerMinutes,
    hostedUsedMinutes,
    openHostedStretch,
    settleHostedStretch,
    usageMonth,
    usageResetsAt,
} from "./hosted-usage.js";

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

const STANDARD = hostedTier(`standard`);

const config = (monthlyHours = FREE_TIER.monthlyHours, ramp: { newAccountDays: number; newAccountHours: number } = { newAccountDays: 0, newAccountHours: 0 }): Config =>
    ({ hosted: { flyApiToken: `fly`, monthlyHours, ...ramp }, hostedPlan: { compEmails: `` } }) as unknown as Config;

// One machine as every budget read names it: which sandbox, which rung, whose account.
const onFree = { sandboxId: `s1`, tier: FREE_TIER.id, ownerId: `u1` };
const onStandard = { sandboxId: `s1`, tier: STANDARD.id, ownerId: `u1` };

const prismaWith = (over: Record<string, Record<string, ReturnType<typeof vi.fn>>>) =>
    ({
        hostedUsage: {
            findUnique: vi.fn().mockResolvedValue(null),
            upsert: vi.fn().mockResolvedValue({}),
            aggregate: vi.fn().mockResolvedValue({ _sum: { minutes: null } }),
        },
        // No open stretch unless a test says so: the live half of the meter reads the machine's own wake stamp.
        hostedMachine: { update: vi.fn().mockResolvedValue({}), findUnique: vi.fn().mockResolvedValue(null), findMany: vi.fn().mockResolvedValue([]) },
        ...over,
    }) as unknown as PrismaClient;

// Fly's answer for one machine read; updated_at is the stamp the meter closes a stretch on.
const stubMachine = (state: string, updatedAt?: string) => {
    vi.stubGlobal(`fetch`, () =>
        Promise.resolve(new Response(JSON.stringify({ id: `m1`, state, ...(updatedAt === undefined ? {} : { updated_at: updatedAt }) }))),
    );
};

afterEach(() => {
    vi.unstubAllGlobals();
});

describe(`the hosted hour meter`, () => {
    it(`keys a month the way the rows are keyed`, () => {
        expect(usageMonth(new Date(`2026-08-13T23:59:00.000Z`))).toBe(`2026-08`);
    });

    it(`resets on the first of the next month, UTC, December included`, () => {
        expect(usageResetsAt(new Date(`2026-08-13T23:59:00.000Z`)).toISOString()).toBe(`2026-09-01T00:00:00.000Z`);
        expect(usageResetsAt(new Date(`2026-12-31T23:59:00.000Z`)).toISOString()).toBe(`2027-01-01T00:00:00.000Z`);
    });

    // The live figure = the settled row plus minutes since the open stretch began, attributed to the month the
    // stretch started in, same as settling would.
    describe(`the live figure`, () => {
        const now = new Date(`2026-08-13T12:00:00.000Z`);

        it(`adds the minutes since the open stretch began to the settled row`, async () => {
            const prisma = prismaWith({
                hostedUsage: { findUnique: vi.fn().mockResolvedValue({ minutes: 100 }) },
                hostedMachine: { update: vi.fn(), findUnique: vi.fn().mockResolvedValue({ wokeAt: new Date(`2026-08-13T10:00:00.000Z`) }) },
            });
            expect(await hostedUsedMinutes(prisma, `s1`, now)).toBe(100 + 120);
        });

        it(`leaves a stretch that began last month to last month's row`, async () => {
            const prisma = prismaWith({
                hostedMachine: { update: vi.fn(), findUnique: vi.fn().mockResolvedValue({ wokeAt: new Date(`2026-07-31T23:00:00.000Z`) }) },
            });
            expect(await hostedUsedMinutes(prisma, `s1`, now)).toBe(0);
        });

        it(`is what the budget reads, so an awake machine can run a month out`, async () => {
            const prisma = prismaWith({
                hostedUsage: { findUnique: vi.fn().mockResolvedValue({ minutes: 2_300 }) },
                hostedMachine: { update: vi.fn(), findUnique: vi.fn().mockResolvedValue({ wokeAt: new Date(`2026-08-13T10:00:00.000Z`) }) },
            });
            expect(await hostedBudgetOf(prisma, config(), onFree, now)).toMatchObject({ usedMinutes: 2_420, remainingMinutes: 0 });
        });
    });

    /* THE CEILING BELONGS TO THE MACHINE'S RUNG. Two machines on one account are two meters, and a paid machine is
     * not unmetered: it has a bigger month, which is the whole reason the ladder's arithmetic works out. */
    describe(`whose month it is, and whether any is left`, () => {
        it(`meters a free machine against this deployment's configured ceiling`, async () => {
            const prisma = prismaWith({ hostedUsage: { findUnique: vi.fn().mockResolvedValue({ minutes: 90 }) } });
            expect(await hostedBudgetOf(prisma, config(), onFree)).toEqual({
                metered: true,
                allowanceMinutes: FREE_TIER.monthlyHours * 60,
                usedMinutes: 90,
                remainingMinutes: FREE_TIER.monthlyHours * 60 - 90,
            });
        });

        it(`meters a paid machine against its own rung's hours, not the free lane's and not nothing`, async () => {
            const prisma = prismaWith({ hostedUsage: { findUnique: vi.fn().mockResolvedValue({ minutes: 90 }) } });
            const budget = await hostedBudgetOf(prisma, config(), onStandard);
            expect(budget.allowanceMinutes).toBe(STANDARD.monthlyHours * 60);
            expect(budget.allowanceMinutes).toBeGreaterThan(FREE_TIER.monthlyHours * 60);
            expect(budget.metered).toBe(true);
        });

        // The operator's knob is the free rung's alone; a paid rung's month is the ladder's and not a deployment's.
        it(`leaves a paid rung metered even where the operator has switched the free ceiling off`, async () => {
            expect(await hostedBudgetOf(prismaWith({}), config(0), onFree)).toMatchObject({ metered: false });
            expect(await hostedBudgetOf(prismaWith({}), config(0), onStandard)).toMatchObject({
                metered: true,
                allowanceMinutes: STANDARD.monthlyHours * 60,
            });
        });

        it(`meters a machine that has never woken at a full allowance rather than at nothing`, async () => {
            expect((await hostedBudgetOf(prismaWith({}), config(), onFree)).remainingMinutes).toBe(FREE_TIER.monthlyHours * 60);
        });

        it(`never reports a negative remainder, however far past the ceiling a stretch ran`, async () => {
            const over = prismaWith({ hostedUsage: { findUnique: vi.fn().mockResolvedValue({ minutes: 99_000 }) } });
            expect(await hostedBudgetOf(over, config(), onFree)).toMatchObject({ usedMinutes: 99_000, remainingMinutes: 0 });
        });
    });

    /* THE ACCOUNT'S MONTH IS A DIFFERENT QUESTION, and it is the one the provision gate asks. It counts minutes
     * whose sandbox has since been released, which is what stops release-and-ask-again being a fresh free month. */
    describe(`the account's month`, () => {
        it(`sums every row of the month, including rows whose sandbox is gone`, async () => {
            const prisma = prismaWith({
                hostedUsage: { aggregate: vi.fn().mockResolvedValue({ _sum: { minutes: 1_800 } }) },
                hostedMachine: { update: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
            });
            expect(await hostedOwnerMinutes(prisma, `u1`)).toBe(1_800);
        });

        it(`refuses a new machine to an account whose released one already spent the month`, async () => {
            const prisma = prismaWith({
                hostedUsage: { aggregate: vi.fn().mockResolvedValue({ _sum: { minutes: FREE_TIER.monthlyHours * 60 } }) },
                hostedMachine: { update: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
            });
            expect(await hostedArrivalBudget(prisma, config(), `u1`)).toMatchObject({ metered: true, remainingMinutes: 0 });
        });

        it(`adds the live minutes of whatever is awake right now`, async () => {
            const now = new Date(`2026-08-13T12:00:00.000Z`);
            const prisma = prismaWith({
                hostedUsage: { aggregate: vi.fn().mockResolvedValue({ _sum: { minutes: 10 } }) },
                hostedMachine: {
                    update: vi.fn(),
                    findMany: vi.fn().mockResolvedValue([{ wokeAt: new Date(`2026-08-13T11:00:00.000Z`) }, { wokeAt: new Date(`2026-08-13T11:30:00.000Z`) }]),
                },
            });
            expect(await hostedOwnerMinutes(prisma, `u1`, now)).toBe(10 + 60 + 30);
        });
    });

    // A fresh account's month is the ramp's figure until the account is old enough; the moment that changes rides
    // along so every surface can say so.
    describe(`the newcomer ramp`, () => {
        const now = new Date(`2026-08-13T12:00:00.000Z`);
        const ramp = { newAccountDays: 7, newAccountHours: 10 };
        const born = (daysAgo: number) => ({ findUnique: vi.fn().mockResolvedValue({ createdAt: new Date(now.getTime() - daysAgo * 24 * 60 * 60_000) }) });

        it(`holds a week-old account to the ramp and says when the full month applies`, async () => {
            const budget = await hostedBudgetOf(prismaWith({ user: born(2) }), config(40, ramp), onFree, now);
            expect(budget).toEqual({
                metered: true,
                allowanceMinutes: 600,
                usedMinutes: 0,
                remainingMinutes: 600,
                rampUntil: new Date(`2026-08-18T12:00:00.000Z`),
            });
        });

        it(`gives an account past the ramp the month's figure, with no ramp end to report`, async () => {
            const budget = await hostedBudgetOf(prismaWith({ user: born(8) }), config(40, ramp), onFree, now);
            expect(budget).toMatchObject({ allowanceMinutes: 2400 });
            expect(budget.rampUntil).toBeUndefined();
        });

        it(`never raises the month: a ramp above the month's figure is the month's figure`, async () => {
            expect(await hostedBudgetOf(prismaWith({ user: born(1) }), config(5, ramp), onFree, now)).toMatchObject({ allowanceMinutes: 300 });
        });

        // A paid rung bought on day one keeps its hours: the ramp is a brake on the free lane, not on a purchase.
        it(`cannot pull a paid rung below what was bought`, async () => {
            const budget = await hostedBudgetOf(prismaWith({ user: born(1) }), config(40, ramp), onStandard, now);
            expect(budget.allowanceMinutes).toBe(600);
        });

        it(`reads no account row at all with the ramp off`, async () => {
            const user = born(1);
            expect(await hostedBudgetOf(prismaWith({ user }), config(40), onFree, now)).toMatchObject({ allowanceMinutes: 2400 });
            expect(user.findUnique).not.toHaveBeenCalled();
        });
    });

    describe(`closing a stretch`, () => {
        const machine = (wokeAt: Date | null) => ({ id: `h1`, sandboxId: `s1`, ownerId: `u1`, appName: `a`, machineId: `m1`, wokeAt });

        it(`bills a stopped machine from its wake to Fly's own stop stamp, then closes the stretch`, async () => {
            stubMachine(`stopped`, `2026-08-13T10:30:00.000Z`);
            const prisma = prismaWith({});
            await settleHostedStretch(prisma, config(), logger, machine(new Date(`2026-08-13T10:00:00.000Z`)));
            // The row names both: the sandbox whose ceiling it counts against, and the account it outlives.
            expect(prisma.hostedUsage.upsert).toHaveBeenCalledWith(
                expect.objectContaining({
                    create: { sandboxId: `s1`, ownerId: `u1`, month: `2026-08`, minutes: 30 },
                    update: { minutes: { increment: 30 } },
                }),
            );
            expect(prisma.hostedMachine.update).toHaveBeenCalledWith({ where: { id: `h1` }, data: { wokeAt: null } });
        });

        // Billing now would risk double-counting at the next settle; the daily sweep closes it once actually stopped.
        it(`leaves a running machine's stretch open and bills nothing`, async () => {
            stubMachine(`started`);
            const prisma = prismaWith({});
            await settleHostedStretch(prisma, config(), logger, machine(new Date(Date.now() - 60_000)));
            expect(prisma.hostedUsage.upsert).not.toHaveBeenCalled();
            expect(prisma.hostedMachine.update).not.toHaveBeenCalled();
        });

        it(`does nothing at all when no stretch is open`, async () => {
            const prisma = prismaWith({});
            await settleHostedStretch(prisma, config(), logger, machine(null));
            expect(prisma.hostedUsage.upsert).not.toHaveBeenCalled();
        });

        // Unreachable isn't evidence anything stopped; guessing would risk billing time that was never used.
        it(`leaves the stretch open when Fly cannot be reached`, async () => {
            vi.stubGlobal(`fetch`, () => Promise.reject(new Error(`network down`)));
            const prisma = prismaWith({});
            await settleHostedStretch(prisma, config(), logger, machine(new Date()));
            expect(prisma.hostedUsage.upsert).not.toHaveBeenCalled();
            expect(prisma.hostedMachine.update).not.toHaveBeenCalled();
        });

        // A stamp older than the wake (clock skew, a replaced machine) would bill a negative stretch.
        it(`falls back to now rather than billing a stop stamp that precedes the wake`, async () => {
            stubMachine(`stopped`, `2020-01-01T00:00:00.000Z`);
            const prisma = prismaWith({});
            await settleHostedStretch(prisma, config(), logger, machine(new Date(Date.now() - 120_000)));
            expect(prisma.hostedUsage.upsert).toHaveBeenCalledWith(expect.objectContaining({ create: expect.objectContaining({ minutes: 2 }) }));
        });

        // Still closes, though: that's what stops the same stretch being counted again later.
        it(`writes no row for a stretch too short to round to a minute, but still closes it`, async () => {
            stubMachine(`stopped`, new Date().toISOString());
            const prisma = prismaWith({});
            await settleHostedStretch(prisma, config(), logger, machine(new Date()));
            expect(prisma.hostedUsage.upsert).not.toHaveBeenCalled();
            expect(prisma.hostedMachine.update).toHaveBeenCalledWith({ where: { id: `h1` }, data: { wokeAt: null } });
        });
    });

    it(`opening a stretch clears the idle warning`, async () => {
        const prisma = prismaWith({});
        await openHostedStretch(prisma, `h1`);
        expect(prisma.hostedMachine.update).toHaveBeenCalledWith({ where: { id: `h1` }, data: { wokeAt: expect.any(Date), idleWarnedAt: null } });
    });
});
