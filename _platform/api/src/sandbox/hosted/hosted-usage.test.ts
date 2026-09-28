import { FREE_TIER, hostedTier } from "@intentic/constants";
import type { PrismaClient } from "@intentic/prisma";
import { stubGlobal, unstubAllGlobals } from "@intentic/testing/bun";
import type { Config } from "../../config.js";
import {
    accountHoursOf,
    closeHostedStretch,
    dropHostedMachine,
    hostedArrivalBudget,
    hostedBudgetOf,
    openHostedStretch,
    settleHostedStretch,
    usageMonth,
    usageResetsAt,
} from "./hosted-usage.js";

const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() } as never;

const STANDARD = hostedTier(`standard`);
const FREE_MINUTES = FREE_TIER.monthlyHours * 60;
const STANDARD_MINUTES = STANDARD.monthlyHours * 60;

const config = (
    monthlyHours = FREE_TIER.monthlyHours,
    ramp: { newAccountDays: number; newAccountHours: number } = { newAccountDays: 0, newAccountHours: 0 },
    compEmails = ``,
): Config => ({ hosted: { flyApiToken: `fly`, monthlyHours, ...ramp }, hostedPlan: { compEmails } }) as unknown as Config;

// The machine row a stretch write names: which row, whose month.
const owned = { id: `h1`, sandboxId: `s1`, ownerId: `u1` };

const prismaWith = (over: Record<string, Record<string, ReturnType<typeof jest.fn>>>) => {
    const prisma = {
        hostedUsage: {
            upsert: jest.fn().mockResolvedValue({}),
            groupBy: jest.fn().mockResolvedValue([]),
        },
        // No machine and no open stretch unless a test says so.
        hostedMachine: { update: jest.fn().mockResolvedValue({}), findUnique: jest.fn().mockResolvedValue(null), findMany: jest.fn().mockResolvedValue([]) },
        // No plan, and an account with no age and no address to judge: the free hours at the month's figure.
        hostedPlan: { findUnique: jest.fn().mockResolvedValue(null) },
        user: { findUnique: jest.fn().mockResolvedValue(null) },
        hostedOom: { create: jest.fn().mockResolvedValue({}), count: jest.fn().mockResolvedValue(0) },
        // A stretch write locks the row and acts in one transaction; the stub runs it in place.
        $transaction: jest.fn((work: (tx: unknown) => Promise<unknown>) => work(prisma)),
        $queryRaw: jest.fn().mockResolvedValue([]),
        ...over,
    };
    return prisma as unknown as PrismaClient;
};

// The machine row as a stretch write's lock reads it: holding `wokeAt`.
const holding = (wokeAt: Date | null, over: Record<string, Record<string, ReturnType<typeof jest.fn>>> = {}) =>
    prismaWith({ ...over, hostedMachine: { update: jest.fn().mockResolvedValue({}), findUnique: jest.fn().mockResolvedValue({ wokeAt }), ...over[`hostedMachine`] } });

// One machine row and its month, stateful, so a case can order a stretch's writers; `charged` is every charge in minutes.
const meterDb = (wokeAt: Date | null, idleWarnedAt: Date | null = null) => {
    const state = { row: { wokeAt, idleWarnedAt } as { wokeAt: Date | null; idleWarnedAt: Date | null } | null, charged: [] as number[] };
    const db = {
        $transaction: jest.fn((work: (tx: unknown) => Promise<unknown>) => work(db)),
        $queryRaw: jest.fn().mockResolvedValue([]),
        hostedMachine: {
            findUnique: jest.fn(async () => (state.row === null ? null : { ...state.row })),
            update: jest.fn(async ({ data }: { data: Partial<{ wokeAt: Date | null; idleWarnedAt: Date | null }> }) => Object.assign(state.row ?? {}, data)),
            delete: jest.fn(async () => {
                state.row = null;
            }),
        },
        hostedUsage: {
            upsert: jest.fn(async ({ create }: { create: { minutes: number } }) => {
                state.charged.push(create.minutes);
            }),
        },
        hostedOom: { create: jest.fn().mockResolvedValue({}) },
    };
    return { prisma: db as unknown as PrismaClient, db, state };
};

// Fly's answer for one machine read; updated_at is the stamp the meter closes a stretch on.
const stubMachine = (state: string, updatedAt?: string) => {
    stubGlobal(`fetch`, () =>
        Promise.resolve(new Response(JSON.stringify({ id: `m1`, state, ...(updatedAt === undefined ? {} : { updated_at: updatedAt }) }))),
    );
};

afterEach(() => {
    unstubAllGlobals();
});

// One account's month as the meter reads it: its machines (oldest first), its plan, its settled rows and the account.
const month = (
    read: {
        machines?: { sandboxId: string; tier: string; wokeAt?: Date | null }[];
        plan?: { status: string; items: { tier: string; quantity: number }[] } | null;
        rows?: { sandboxId: string | null; tier: string; minutes: number }[];
        owner?: { createdAt: Date; email: string } | null;
    } = {},
) =>
    prismaWith({
        hostedMachine: {
            update: jest.fn(),
            findUnique: jest.fn().mockResolvedValue(null),
            findMany: jest.fn().mockResolvedValue((read.machines ?? []).map((machine) => ({ wokeAt: null, ...machine }))),
        },
        hostedPlan: { findUnique: jest.fn().mockResolvedValue(read.plan ?? null) },
        hostedUsage: {
            upsert: jest.fn(),
            groupBy: jest.fn().mockResolvedValue((read.rows ?? []).map(({ minutes, ...key }) => ({ ...key, _sum: { minutes } }))),
        },
        user: { findUnique: jest.fn().mockResolvedValue(read.owner ?? null) },
    });

// A live subscription holding `quantity` Standard slots, and the same plan with its charge failing.
const standardSlots = (quantity: number, status = `active`) => ({ status, items: [{ tier: STANDARD.id, quantity }] });

describe(`the hosted hour meter`, () => {
    const now = new Date(`2026-08-13T12:00:00.000Z`);

    it(`keys a month the way the rows are keyed`, () => {
        expect(usageMonth(new Date(`2026-08-13T23:59:00.000Z`))).toBe(`2026-08`);
    });

    it(`resets on the first of the next month, UTC, December included`, () => {
        expect(usageResetsAt(new Date(`2026-08-13T23:59:00.000Z`)).toISOString()).toBe(`2026-09-01T00:00:00.000Z`);
        expect(usageResetsAt(new Date(`2026-12-31T23:59:00.000Z`)).toISOString()).toBe(`2027-01-01T00:00:00.000Z`);
    });

    /* THE FREE HOURS ARE THE ACCOUNT'S: one allowance a month, spent by every machine that does not stand on a paid
     * slot, released ones included. Two free machines are one month, not two, and letting one go is not a fresh one. */
    describe(`the account's free hours`, () => {
        it(`counts every free minute of the month against one allowance, a released machine's included`, async () => {
            const prisma = month({
                machines: [{ sandboxId: `s1`, tier: FREE_TIER.id }],
                rows: [
                    { sandboxId: `s1`, tier: FREE_TIER.id, minutes: 600 },
                    { sandboxId: null, tier: FREE_TIER.id, minutes: 1_200 },
                ],
            });
            const hours = await accountHoursOf(prisma, config(), `u1`, now);
            expect(hours.free).toEqual({
                kind: `free`,
                tier: FREE_TIER.id,
                metered: true,
                allowanceMinutes: FREE_MINUTES,
                remainingMinutes: FREE_MINUTES - 1_800,
                usedMinutes: 1_800,
            });
            // The free machine spends exactly those hours, not a month of its own.
            expect(hours.machines.get(`s1`)).toBe(hours.free);
        });

        it(`refuses a new machine to an account whose released one already spent the month`, async () => {
            const prisma = month({ rows: [{ sandboxId: null, tier: FREE_TIER.id, minutes: FREE_MINUTES }] });
            expect(await hostedArrivalBudget(prisma, config(), `u1`, now)).toMatchObject({ kind: `free`, metered: true, remainingMinutes: 0 });
        });

        // The hole this closes: a machine released at 39 hours used to hand the next one a fresh forty.
        it(`gives a second free machine what is left of the same hours, not a fresh month`, async () => {
            const prisma = month({
                machines: [
                    { sandboxId: `s1`, tier: FREE_TIER.id },
                    { sandboxId: `s2`, tier: FREE_TIER.id, wokeAt: new Date(now.getTime() - 120 * 60_000) },
                ],
                rows: [{ sandboxId: null, tier: FREE_TIER.id, minutes: FREE_MINUTES - 60 }],
            });
            expect(await hostedBudgetOf(prisma, config(), { sandboxId: `s2`, ownerId: `u1` }, now)).toMatchObject({
                kind: `free`,
                usedMinutes: FREE_MINUTES + 60,
                remainingMinutes: 0,
            });
        });

        // An open stretch counts live, towards the month it began in, same as settling will charge it.
        it(`adds the minutes since an open stretch began, and none for one that began last month`, async () => {
            const awake = month({
                machines: [{ sandboxId: `s1`, tier: FREE_TIER.id, wokeAt: new Date(`2026-08-13T10:00:00.000Z`) }],
                rows: [{ sandboxId: `s1`, tier: FREE_TIER.id, minutes: 100 }],
            });
            expect((await accountHoursOf(awake, config(), `u1`, now)).free.usedMinutes).toBe(100 + 120);
            const fromLastMonth = month({ machines: [{ sandboxId: `s1`, tier: FREE_TIER.id, wokeAt: new Date(`2026-07-31T23:00:00.000Z`) }] });
            expect((await accountHoursOf(fromLastMonth, config(), `u1`, now)).free.usedMinutes).toBe(0);
        });

        it(`meters an account that has spent nothing at the full allowance rather than at nothing`, async () => {
            expect((await hostedArrivalBudget(month(), config(), `u1`, now)).remainingMinutes).toBe(FREE_MINUTES);
        });

        it(`never reports a negative remainder, however far past the ceiling a stretch ran`, async () => {
            const over = month({ machines: [{ sandboxId: `s1`, tier: FREE_TIER.id }], rows: [{ sandboxId: `s1`, tier: FREE_TIER.id, minutes: 99_000 }] });
            expect(await hostedBudgetOf(over, config(), { sandboxId: `s1`, ownerId: `u1` }, now)).toMatchObject({ usedMinutes: 99_000, remainingMinutes: 0 });
        });

        // The operator's knob switches the ceiling off, not the counting: the month is still there to be read.
        it(`counts against no ceiling where the platform sets none`, async () => {
            const prisma = month({ rows: [{ sandboxId: null, tier: FREE_TIER.id, minutes: 90 }] });
            expect((await accountHoursOf(prisma, config(0), `u1`, now)).free).toEqual({
                kind: `free`,
                tier: FREE_TIER.id,
                metered: false,
                allowanceMinutes: 0,
                remainingMinutes: 0,
                usedMinutes: 90,
            });
        });
    });

    /* A PAID SLOT'S HOURS ARE ITS MACHINE'S, and only while the slot is held: a machine that moved up keeps the free
     * minutes it spent before the move in the free hours, and a machine whose slot lapsed spends the free hours again. */
    describe(`a machine's own month on a paid slot`, () => {
        it(`meters a machine on a held slot against its rung's hours, apart from the free ones it spent before`, async () => {
            const prisma = month({
                machines: [{ sandboxId: `s1`, tier: STANDARD.id }],
                plan: standardSlots(1),
                rows: [
                    { sandboxId: `s1`, tier: FREE_TIER.id, minutes: FREE_MINUTES },
                    { sandboxId: `s1`, tier: STANDARD.id, minutes: 90 },
                ],
            });
            const hours = await accountHoursOf(prisma, config(), `u1`, now);
            expect(hours.machines.get(`s1`)).toEqual({
                kind: `slot`,
                tier: STANDARD.id,
                metered: true,
                allowanceMinutes: STANDARD_MINUTES,
                remainingMinutes: STANDARD_MINUTES - 90,
                usedMinutes: 90,
            });
            expect(hours.free).toMatchObject({ usedMinutes: FREE_MINUTES, remainingMinutes: 0 });
        });

        // The operator's knob is the free rung's alone; a paid rung's month is the ladder's and not a deployment's.
        it(`leaves a paid slot metered where the operator has switched the free ceiling off`, async () => {
            const prisma = month({ machines: [{ sandboxId: `s1`, tier: STANDARD.id }], plan: standardSlots(1) });
            const hours = await accountHoursOf(prisma, config(0), `u1`, now);
            expect(hours.free.metered).toBe(false);
            expect(hours.machines.get(`s1`)).toMatchObject({ kind: `slot`, metered: true, allowanceMinutes: STANDARD_MINUTES });
        });

        it(`spends the free hours on a machine whose plan stopped paying, whatever size it still is`, async () => {
            const prisma = month({ machines: [{ sandboxId: `s1`, tier: STANDARD.id }], plan: standardSlots(1, `past_due`) });
            const hours = await accountHoursOf(prisma, config(), `u1`, now);
            expect(hours.machines.get(`s1`)).toBe(hours.free);
        });

        // A resubscription that bought back fewer slots than machines stand at the rung: the oldest keep theirs.
        it(`gives the held slots to the oldest machines at the rung, and the free hours to the rest`, async () => {
            const prisma = month({
                machines: [
                    { sandboxId: `older`, tier: STANDARD.id },
                    { sandboxId: `newer`, tier: STANDARD.id },
                ],
                plan: standardSlots(1),
            });
            const hours = await accountHoursOf(prisma, config(), `u1`, now);
            expect(hours.machines.get(`older`)).toMatchObject({ kind: `slot`, tier: STANDARD.id });
            expect(hours.machines.get(`newer`)).toBe(hours.free);
        });

        // An open stretch on a slot counts towards the slot, never towards the free hours beside it.
        it(`counts a paid machine's open stretch towards its own month only`, async () => {
            const prisma = month({
                machines: [{ sandboxId: `s1`, tier: STANDARD.id, wokeAt: new Date(`2026-08-13T11:00:00.000Z`) }],
                plan: standardSlots(1),
            });
            const hours = await accountHoursOf(prisma, config(), `u1`, now);
            expect(hours.machines.get(`s1`)?.usedMinutes).toBe(60);
            expect(hours.free.usedMinutes).toBe(0);
        });
    });

    /* ON THE HOUSE MEANS ON THE HOUSE: a comped account's minutes are counted as anybody's are, against no ceiling. A
     * paying account is a subscriber first, as the plan state reads it, so a comp never waives a slot's own month. */
    describe(`a comp`, () => {
        const comped = config(FREE_TIER.monthlyHours, undefined, ` Friend@Example.com `);
        const friend = { createdAt: new Date(`2026-01-01T00:00:00.000Z`), email: `friend@example.com` };

        it(`counts a comped account's hours against no ceiling`, async () => {
            const prisma = month({ owner: friend, machines: [{ sandboxId: `s1`, tier: FREE_TIER.id }], rows: [{ sandboxId: `s1`, tier: FREE_TIER.id, minutes: 9_000 }] });
            expect(await hostedBudgetOf(prisma, comped, { sandboxId: `s1`, ownerId: `u1` }, now)).toEqual({
                kind: `free`,
                tier: FREE_TIER.id,
                metered: false,
                allowanceMinutes: 0,
                remainingMinutes: 0,
                usedMinutes: 9_000,
            });
        });

        it(`leaves a comped subscriber's slot on its own month`, async () => {
            const prisma = month({ owner: friend, machines: [{ sandboxId: `s1`, tier: STANDARD.id }], plan: standardSlots(1) });
            const hours = await accountHoursOf(prisma, comped, `u1`, now);
            expect(hours.machines.get(`s1`)).toMatchObject({ kind: `slot`, metered: true, allowanceMinutes: STANDARD_MINUTES });
            expect(hours.free.metered).toBe(true);
        });
    });

    // A fresh account's free hours are the ramp's figure until the account is old enough; the moment that changes
    // rides along so every surface can say so.
    describe(`the newcomer ramp`, () => {
        const ramp = { newAccountDays: 7, newAccountHours: 10 };
        const born = (daysAgo: number) => ({ createdAt: new Date(now.getTime() - daysAgo * 24 * 60 * 60_000), email: `new@example.com` });

        it(`holds a week-old account to the ramp and says when the full month applies`, async () => {
            expect(await hostedArrivalBudget(month({ owner: born(2) }), config(40, ramp), `u1`, now)).toEqual({
                kind: `free`,
                tier: FREE_TIER.id,
                metered: true,
                allowanceMinutes: 600,
                remainingMinutes: 600,
                usedMinutes: 0,
                rampUntil: new Date(`2026-08-18T12:00:00.000Z`),
            });
        });

        it(`gives an account past the ramp the month's figure, with no ramp end to report`, async () => {
            const budget = await hostedArrivalBudget(month({ owner: born(8) }), config(40, ramp), `u1`, now);
            expect(budget).toMatchObject({ allowanceMinutes: 2_400 });
            expect(budget.rampUntil).toBeUndefined();
        });

        it(`never raises the month: a ramp above the month's figure is the month's figure`, async () => {
            expect(await hostedArrivalBudget(month({ owner: born(1) }), config(5, ramp), `u1`, now)).toMatchObject({ allowanceMinutes: 300 });
        });

        // A slot bought on day one keeps its hours: the ramp is a brake on the free plan, not on a purchase.
        it(`cannot pull a paid slot below what was bought`, async () => {
            const prisma = month({ owner: born(1), machines: [{ sandboxId: `s1`, tier: STANDARD.id }], plan: standardSlots(1) });
            const hours = await accountHoursOf(prisma, config(40, ramp), `u1`, now);
            expect(hours.machines.get(`s1`)).toMatchObject({ allowanceMinutes: STANDARD_MINUTES });
            expect(hours.machines.get(`s1`)?.rampUntil).toBeUndefined();
            expect(hours.free).toMatchObject({ allowanceMinutes: 600 });
        });
    });

    /* WHAT A MINUTE WAS CHARGED TO is written when it is charged, by the same rule the meter reads with: the machine's
     * own rung while it stands on a held slot, the account's free hours otherwise. */
    describe(`which hours a charge lands on`, () => {
        const settleOn = async (tier: string, plan: { status: string; items: { tier: string; quantity: number }[] } | null) => {
            stubMachine(`stopped`, `2026-08-13T10:30:00.000Z`);
            const wokeAt = new Date(`2026-08-13T10:00:00.000Z`);
            const prisma = prismaWith({
                hostedMachine: {
                    update: jest.fn().mockResolvedValue({}),
                    findUnique: jest.fn().mockResolvedValue({ wokeAt, tier }),
                    findMany: jest.fn().mockResolvedValue([{ sandboxId: `s1`, tier }]),
                },
                hostedPlan: { findUnique: jest.fn().mockResolvedValue(plan) },
            });
            await settleHostedStretch(prisma, config(), logger, { id: `h1`, sandboxId: `s1`, ownerId: `u1`, appName: `a`, machineId: `m1`, wokeAt });
            return prisma;
        };

        it(`charges a machine on a held slot to its rung`, async () => {
            expect((await settleOn(STANDARD.id, standardSlots(1))).hostedUsage.upsert).toHaveBeenCalledWith({
                where: { sandboxId_month_tier: { sandboxId: `s1`, month: `2026-08`, tier: STANDARD.id } },
                create: { sandboxId: `s1`, ownerId: `u1`, month: `2026-08`, tier: STANDARD.id, minutes: 30 },
                update: { minutes: { increment: 30 } },
            });
        });

        it(`charges the same machine to the free hours once its plan stops paying`, async () => {
            expect((await settleOn(STANDARD.id, standardSlots(1, `canceled`))).hostedUsage.upsert).toHaveBeenCalledWith(
                expect.objectContaining({ create: { sandboxId: `s1`, ownerId: `u1`, month: `2026-08`, tier: FREE_TIER.id, minutes: 30 } }),
            );
        });

        it(`charges a free machine to the free hours without asking about a plan`, async () => {
            const prisma = await settleOn(FREE_TIER.id, standardSlots(1));
            expect(prisma.hostedUsage.upsert).toHaveBeenCalledWith(
                expect.objectContaining({ create: { sandboxId: `s1`, ownerId: `u1`, month: `2026-08`, tier: FREE_TIER.id, minutes: 30 } }),
            );
            expect(prisma.hostedPlan.findUnique).not.toHaveBeenCalled();
        });
    });

    describe(`closing a stretch`, () => {
        const machine = (wokeAt: Date | null) => ({
            id: `h1`,
            sandboxId: `s1`,
            ownerId: `u1`,
            tier: FREE_TIER.id,
            memoryMb: FREE_TIER.memoryMb,
            appName: `a`,
            machineId: `m1`,
            wokeAt,
        });

        it(`bills a stopped machine from its wake to Fly's own stop stamp, then closes the stretch`, async () => {
            stubMachine(`stopped`, `2026-08-13T10:30:00.000Z`);
            const wokeAt = new Date(`2026-08-13T10:00:00.000Z`);
            const prisma = holding(wokeAt);
            await settleHostedStretch(prisma, config(), logger, machine(wokeAt));
            // The row names both: the sandbox whose ceiling it counts against, and the account it outlives.
            expect(prisma.hostedUsage.upsert).toHaveBeenCalledWith({
                where: { sandboxId_month_tier: { sandboxId: `s1`, month: `2026-08`, tier: FREE_TIER.id } },
                create: { sandboxId: `s1`, ownerId: `u1`, month: `2026-08`, tier: FREE_TIER.id, minutes: 30 },
                update: { minutes: { increment: 30 } },
            });
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
            stubGlobal(`fetch`, () => Promise.reject(new Error(`network down`)));
            const prisma = prismaWith({});
            await settleHostedStretch(prisma, config(), logger, machine(new Date()));
            expect(prisma.hostedUsage.upsert).not.toHaveBeenCalled();
            expect(prisma.hostedMachine.update).not.toHaveBeenCalled();
        });

        // A stamp older than the wake (clock skew, a replaced machine) would bill a negative stretch.
        it(`falls back to now rather than billing a stop stamp that precedes the wake`, async () => {
            stubMachine(`stopped`, `2020-01-01T00:00:00.000Z`);
            const wokeAt = new Date(Date.now() - 120_000);
            const prisma = holding(wokeAt);
            await settleHostedStretch(prisma, config(), logger, machine(wokeAt));
            expect(prisma.hostedUsage.upsert).toHaveBeenCalledWith(expect.objectContaining({ create: expect.objectContaining({ minutes: 2 }) }));
        });

        // Still closes, though: that's what stops the same stretch being counted again later.
        it(`writes no row for a stretch too short to round to a minute, but still closes it`, async () => {
            stubMachine(`stopped`, new Date().toISOString());
            const wokeAt = new Date();
            const prisma = holding(wokeAt);
            await settleHostedStretch(prisma, config(), logger, machine(wokeAt));
            expect(prisma.hostedUsage.upsert).not.toHaveBeenCalled();
            expect(prisma.hostedMachine.update).toHaveBeenCalledWith({ where: { id: `h1` }, data: { wokeAt: null } });
        });
    });

    /* THE SETTLE IS WHERE AN OUT-OF-MEMORY KILL IS SEEN, because it is already asking the provider how the machine
     * ended. Nothing else on the platform can see inside a machine, and this costs no extra round trip. */
    describe(`a machine the kernel killed`, () => {
        const oomKilled = (state: string) => {
            stubGlobal(`fetch`, () =>
                Promise.resolve(
                    new Response(
                        JSON.stringify({
                            id: `m1`,
                            state,
                            updated_at: `2026-08-13T10:30:00.000Z`,
                            events: [{ timestamp: 2, request: { exit_event: { exit_code: 137, oom_killed: true } } }],
                        }),
                    ),
                ),
            );
        };

        const machine = { id: `h1`, sandboxId: `s1`, ownerId: `u1`, tier: FREE_TIER.id, memoryMb: FREE_TIER.memoryMb, appName: `a`, machineId: `m1` };

        it(`writes the kill with the rung and memory the machine HAD, and still settles the stretch`, async () => {
            oomKilled(`stopped`);
            const create = jest.fn().mockResolvedValue({});
            const wokeAt = new Date(`2026-08-13T10:00:00.000Z`);
            const prisma = holding(wokeAt, { hostedOom: { create } });
            await settleHostedStretch(prisma, config(), logger, { ...machine, wokeAt });
            expect(create).toHaveBeenCalledWith({
                data: { hostedMachineId: `h1`, sandboxId: `s1`, tier: FREE_TIER.id, memoryMb: FREE_TIER.memoryMb },
            });
            // Thirty minutes from the wake to Fly's stop stamp, billed as usual: the kill is a note beside it.
            expect(prisma.hostedUsage.upsert).toHaveBeenCalledWith(
                expect.objectContaining({ create: { sandboxId: `s1`, ownerId: `u1`, month: `2026-08`, tier: FREE_TIER.id, minutes: 30 } }),
            );
        });

        // A machine still running has not ended, so its last exit event is an older life's and says nothing about now.
        it(`writes nothing for a machine that is still up`, async () => {
            oomKilled(`started`);
            const create = jest.fn();
            const prisma = prismaWith({ hostedOom: { create } });
            await settleHostedStretch(prisma, config(), logger, { ...machine, wokeAt: new Date() });
            expect(create).not.toHaveBeenCalled();
        });

        // A bookkeeping row must never be the thing that leaves a stretch open and a machine billing forever.
        it(`settles the stretch even when the kill cannot be written down`, async () => {
            oomKilled(`stopped`);
            const create = jest.fn().mockRejectedValue(new Error(`write failed`));
            const wokeAt = new Date(`2026-08-13T10:00:00.000Z`);
            const prisma = holding(wokeAt, { hostedOom: { create } });
            await settleHostedStretch(prisma, config(), logger, { ...machine, wokeAt });
            expect(prisma.hostedMachine.update).toHaveBeenCalledWith({ where: { id: `h1` }, data: { wokeAt: null } });
        });

        // Two settles that read one stretch both see the kill; only the one that closed the stretch writes it down.
        it(`writes one kill however many settles of the stretch race`, async () => {
            oomKilled(`stopped`);
            const wokeAt = new Date(`2026-08-13T10:00:00.000Z`);
            const { prisma, db } = meterDb(wokeAt);
            await settleHostedStretch(prisma, config(), logger, { ...machine, wokeAt });
            await settleHostedStretch(prisma, config(), logger, { ...machine, wokeAt });
            expect(db.hostedOom.create).toHaveBeenCalledTimes(1);
        });
    });

    it(`opening a stretch clears the idle warning`, async () => {
        const { prisma, state } = meterDb(null, new Date(`2026-08-13T10:00:00.000Z`));
        expect(await openHostedStretch(prisma, owned)).toBe(true);
        expect(state.row).toEqual({ wokeAt: expect.any(Date), idleWarnedAt: null });
        expect(state.charged).toEqual([]);
    });

    // Orders of writers the model explores (specs/HostedStretch.tla); each must leave every stretch charged exactly once.
    describe(`writers racing for one stretch`, () => {
        const stretch = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000);
        const read = (wokeAt: Date) => ({ ...owned, tier: FREE_TIER.id, memoryMb: FREE_TIER.memoryMb, appName: `a`, machineId: `m1`, wokeAt });

        // A browser that loses its daemon calls wake on a machine that never stopped; the settle leaves it open.
        it(`a wake on a machine that never stopped charges the stretch it was in, then opens the next`, async () => {
            const wokeAt = stretch(90);
            const { prisma, state } = meterDb(wokeAt);
            expect(await openHostedStretch(prisma, owned)).toBe(true);
            expect(state.charged).toEqual([90]);
            expect(state.row?.wokeAt?.getTime()).toBeGreaterThan(wokeAt.getTime());
        });

        // Abuse and a wake, or the meter and a wake, each holding the same stretch they read before the other closed it.
        it(`two closes of one stretch charge it once`, async () => {
            stubMachine(`stopped`, new Date().toISOString());
            const wokeAt = stretch(30);
            const { prisma, state } = meterDb(wokeAt);
            await settleHostedStretch(prisma, config(), logger, read(wokeAt));
            expect(await closeHostedStretch(prisma, { ...owned, wokeAt }, new Date())).toBeUndefined();
            expect(state.charged).toEqual([30]);
            expect(state.row?.wokeAt).toBeNull();
        });

        // The meter read stretch 1, a wake then settled it and opened stretch 2: the meter's close must touch neither.
        it(`a settle holding a stretch the row has moved past charges nothing and leaves the newer one open`, async () => {
            stubMachine(`stopped`, new Date().toISOString());
            const newer = stretch(5);
            const { prisma, state } = meterDb(newer);
            await settleHostedStretch(prisma, config(), logger, read(stretch(60)));
            expect(state.charged).toEqual([]);
            expect(state.row?.wokeAt).toEqual(newer);
        });

        // The idle sweep saw a stop, then a wake opened a newer stretch before the delete: that stop is not its end.
        it(`deleting the row charges the stretch it holds, up to now when the caller's stop stamp predates it`, async () => {
            const { prisma, state } = meterDb(stretch(10));
            await dropHostedMachine(prisma, owned, stretch(60));
            expect(state.charged).toEqual([10]);
            expect(state.row).toBeNull();
        });

        it(`deleting a row that is already gone charges nothing`, async () => {
            const { prisma, db, state } = meterDb(stretch(10));
            state.row = null;
            await dropHostedMachine(prisma, owned);
            expect(state.charged).toEqual([]);
            expect(db.hostedMachine.delete).not.toHaveBeenCalled();
        });

        // The row went (trash, release, the idle sweep) while a wake was starting the machine: nothing is left to bill.
        it(`opening a stretch on a row that is gone reports it, so the caller can stop the machine`, async () => {
            const { prisma, state } = meterDb(null);
            state.row = null;
            expect(await openHostedStretch(prisma, owned)).toBe(false);
            expect(state.charged).toEqual([]);
        });
    });
});
