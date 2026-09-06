import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@intentic/prisma";
import type { Config } from "../../config.js";
import { hostedBudgetOf, hostedUsedMinutes, openHostedStretch, settleHostedStretch, usageMonth, usageResetsAt } from "./hosted-usage.js";

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

const config = (monthlyHours = 40): Config => ({ hosted: { flyApiToken: `fly`, monthlyHours }, hostedPlan: { compEmails: `` } }) as unknown as Config;

const prismaWith = (over: Record<string, Record<string, ReturnType<typeof vi.fn>>>) =>
    ({
        hostedPlan: { findUnique: vi.fn().mockResolvedValue(null) },
        hostedUsage: { findUnique: vi.fn().mockResolvedValue(null), upsert: vi.fn().mockResolvedValue({}) },
        // No open stretch unless a test says so: the live half of the meter reads the owner's woken machines.
        hostedMachine: { update: vi.fn().mockResolvedValue({}), findMany: vi.fn().mockResolvedValue([]) },
        ...over,
    }) as unknown as PrismaClient;

// Fly's answer for one machine read. `updated_at` is the stamp the meter closes a stretch on.
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

    /* THE OPEN STRETCH COUNTS. A machine awake for 39 hours used to read as 40 left, because only a settled
     * row was ever read; the ceiling was a cap on stopping, not on hours. The live figure is the row plus
     * the minutes since each of the owner's machines woke, attributed to the month the stretch STARTED in,
     * exactly as settling will attribute it. */
    describe(`the live figure`, () => {
        const now = new Date(`2026-08-13T12:00:00.000Z`);

        it(`adds the minutes since each open stretch began to the settled row`, async () => {
            const prisma = prismaWith({
                hostedUsage: { findUnique: vi.fn().mockResolvedValue({ minutes: 100 }) },
                hostedMachine: {
                    update: vi.fn(),
                    findMany: vi.fn().mockResolvedValue([{ wokeAt: new Date(`2026-08-13T10:00:00.000Z`) }, { wokeAt: new Date(`2026-08-13T11:30:00.000Z`) }]),
                },
            });
            expect(await hostedUsedMinutes(prisma, `u1`, now)).toBe(100 + 120 + 30);
        });

        it(`leaves a stretch that began last month to last month's row`, async () => {
            const prisma = prismaWith({ hostedMachine: { update: vi.fn(), findMany: vi.fn().mockResolvedValue([{ wokeAt: new Date(`2026-07-31T23:00:00.000Z`) }]) } });
            expect(await hostedUsedMinutes(prisma, `u1`, now)).toBe(0);
        });

        it(`is what the budget reads, so an awake machine can run a month out`, async () => {
            const prisma = prismaWith({
                hostedUsage: { findUnique: vi.fn().mockResolvedValue({ minutes: 2_300 }) },
                hostedMachine: { update: vi.fn(), findMany: vi.fn().mockResolvedValue([{ wokeAt: new Date(`2026-08-13T10:00:00.000Z`) }]) },
            });
            expect(await hostedBudgetOf(prisma, config(), `u1`, now)).toMatchObject({ usedMinutes: 2_420, remainingMinutes: 0 });
        });
    });

    describe(`whose month it is, and whether any is left`, () => {
        it(`meters a non-member against the configured ceiling`, async () => {
            const budget = await hostedBudgetOf(
                prismaWith({ hostedUsage: { findUnique: vi.fn().mockResolvedValue({ minutes: 90 }) } }),
                config(),
                `u1`,
            );
            expect(budget).toEqual({ metered: true, allowanceMinutes: 2400, usedMinutes: 90, remainingMinutes: 2310 });
        });

        it(`meters an account that has never woken a machine at a full allowance rather than at nothing`, async () => {
            const budget = await hostedBudgetOf(prismaWith({}), config(), `u1`);
            expect(budget.remainingMinutes).toBe(2400);
        });

        /* Two ways to be unmetered, and both must answer WITHOUT reading the meter: a member, and a platform
         * running with no ceiling at all (the self-hosted default). The membership read short-circuits, so a
         * member never pays a query to be told a limit does not apply to them. */
        it(`exempts a member without reading the meter`, async () => {
            const usage = { findUnique: vi.fn().mockResolvedValue({ minutes: 99_999 }) };
            const prisma = prismaWith({ hostedPlan: { findUnique: vi.fn().mockResolvedValue({ status: `active` }) }, hostedUsage: usage });
            expect(await hostedBudgetOf(prisma, config(), `u1`)).toMatchObject({ metered: false });
            expect(usage.findUnique).not.toHaveBeenCalled();
        });

        it(`exempts everyone when the platform sets no ceiling`, async () => {
            expect(await hostedBudgetOf(prismaWith({}), config(0), `u1`)).toMatchObject({ metered: false });
        });

        // past_due is not on the plan (hosted-plan's rule): a charge that failed pauses the exemption too,
        // otherwise a lapsed card would buy unmetered hours for as long as Stripe kept retrying.
        it(`meters an owner whose payment is failing`, async () => {
            const prisma = prismaWith({ hostedPlan: { findUnique: vi.fn().mockResolvedValue({ status: `past_due` }) } });
            expect(await hostedBudgetOf(prisma, config(), `u1`)).toMatchObject({ metered: true });
        });

        it(`never reports a negative remainder, however far past the ceiling a stretch ran`, async () => {
            const over = prismaWith({ hostedUsage: { findUnique: vi.fn().mockResolvedValue({ minutes: 9_000 }) } });
            expect(await hostedBudgetOf(over, config(), `u1`)).toMatchObject({ usedMinutes: 9_000, remainingMinutes: 0 });
        });
    });

    describe(`closing a stretch`, () => {
        it(`bills a stopped machine from its wake to Fly's own stop stamp, then closes the stretch`, async () => {
            stubMachine(`stopped`, `2026-08-13T10:30:00.000Z`);
            const prisma = prismaWith({});
            await settleHostedStretch(
                prisma,
                config(),
                logger,
                { id: `h1`, appName: `a`, machineId: `m1`, wokeAt: new Date(`2026-08-13T10:00:00.000Z`) },
                `u1`,
            );
            expect(prisma.hostedUsage.upsert).toHaveBeenCalledWith(
                expect.objectContaining({ create: { userId: `u1`, month: `2026-08`, minutes: 30 }, update: { minutes: { increment: 30 } } }),
            );
            expect(prisma.hostedMachine.update).toHaveBeenCalledWith({ where: { id: `h1` }, data: { wokeAt: null } });
        });

        /* A running machine's stretch is real but unfinished. Billing it now would either double-count it at
         * the next settle or need a second stamp to remember it had not, so it is left open, and the daily
         * sweep closes it once the box has actually stopped. */
        it(`leaves a running machine's stretch open and bills nothing`, async () => {
            stubMachine(`started`);
            const prisma = prismaWith({});
            await settleHostedStretch(
                prisma,
                config(),
                logger,
                { id: `h1`, appName: `a`, machineId: `m1`, wokeAt: new Date(Date.now() - 60_000) },
                `u1`,
            );
            expect(prisma.hostedUsage.upsert).not.toHaveBeenCalled();
            expect(prisma.hostedMachine.update).not.toHaveBeenCalled();
        });

        it(`does nothing at all when no stretch is open`, async () => {
            const prisma = prismaWith({});
            await settleHostedStretch(prisma, config(), logger, { id: `h1`, appName: `a`, machineId: `m1`, wokeAt: null }, `u1`);
            expect(prisma.hostedUsage.upsert).not.toHaveBeenCalled();
        });

        /* A provider we cannot reach is not evidence that anything stopped. Leaving the stretch open costs a
         * day of accuracy; guessing would charge for time that may never have been used. */
        it(`leaves the stretch open when Fly cannot be reached`, async () => {
            vi.stubGlobal(`fetch`, () => Promise.reject(new Error(`network down`)));
            const prisma = prismaWith({});
            await settleHostedStretch(prisma, config(), logger, { id: `h1`, appName: `a`, machineId: `m1`, wokeAt: new Date() }, `u1`);
            expect(prisma.hostedUsage.upsert).not.toHaveBeenCalled();
            expect(prisma.hostedMachine.update).not.toHaveBeenCalled();
        });

        // A stamp older than the wake (clock skew, a replaced machine) would bill a negative stretch and
        // silently credit the month. Falling back to now is the latest the stretch could honestly have ended.
        it(`falls back to now rather than billing a stop stamp that precedes the wake`, async () => {
            stubMachine(`stopped`, `2020-01-01T00:00:00.000Z`);
            const prisma = prismaWith({});
            await settleHostedStretch(
                prisma,
                config(),
                logger,
                { id: `h1`, appName: `a`, machineId: `m1`, wokeAt: new Date(Date.now() - 120_000) },
                `u1`,
            );
            expect(prisma.hostedUsage.upsert).toHaveBeenCalledWith(expect.objectContaining({ create: expect.objectContaining({ minutes: 2 }) }));
        });

        // A sub-minute stretch rounds to nothing, and writing a zero-minute row would be a row that says
        // nothing happened. The stretch still closes: that is what stops it being counted twice later.
        it(`writes no row for a stretch too short to round to a minute, but still closes it`, async () => {
            stubMachine(`stopped`, new Date().toISOString());
            const prisma = prismaWith({});
            await settleHostedStretch(prisma, config(), logger, { id: `h1`, appName: `a`, machineId: `m1`, wokeAt: new Date() }, `u1`);
            expect(prisma.hostedUsage.upsert).not.toHaveBeenCalled();
            expect(prisma.hostedMachine.update).toHaveBeenCalledWith({ where: { id: `h1` }, data: { wokeAt: null } });
        });
    });

    // Opening a stretch also cancels any pending collection: a machine somebody just woke is plainly in use.
    it(`opening a stretch clears the idle warning`, async () => {
        const prisma = prismaWith({});
        await openHostedStretch(prisma, `h1`);
        expect(prisma.hostedMachine.update).toHaveBeenCalledWith({ where: { id: `h1` }, data: { wokeAt: expect.any(Date), idleWarnedAt: null } });
    });
});
