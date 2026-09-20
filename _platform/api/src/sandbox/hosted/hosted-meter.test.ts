import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@intentic/prisma";
import type { Config } from "../../config.js";
import { FREE_TIER, hostedTier } from "@intentic/constants";
import { stopOverBudgetHosted } from "./hosted-meter.js";

const STANDARD = hostedTier(`standard`);

// Reads the open stretch live and stops a machine once ITS OWN month exceeds ITS OWN rung's ceiling plus the grace.
// Judged per machine, not per account: an account holding a spent free machine and a Standard one nowhere near its
// hours loses only the first. A machine under its ceiling and one that already stopped are left alone.

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

const NOW = new Date(`2026-08-13T12:00:00.000Z`);

const config = (over: Record<string, unknown> = {}): Config =>
    ({
        // The lane needs both the credential and the edge (hostedEnabled), like the idle sweep's fixture.
        ingress: { url: `https://ingress.sbx.test`, signingKey: `k`, zone: `sbx.test` },
        hosted: { flyApiToken: `fly`, flyOrg: `intentic`, monthlyHours: 40, overBudgetGraceMinutes: 60, newAccountDays: 0, newAccountHours: 0, ...over },
        hostedPlan: { compEmails: `` },
    }) as unknown as Config;

// One machine with an open stretch, as the tick selects it.
const machine = (over: Record<string, unknown> = {}) => ({
    id: `h1`,
    sandboxId: `s1`,
    tier: FREE_TIER.id,
    appName: `intentic-sbx-a`,
    machineId: `m1`,
    wokeAt: new Date(NOW.getTime() - 10 * 60_000),
    sandbox: { ownerId: `u1` },
    ...over,
});

const prismaWith = (rows: ReturnType<typeof machine>[], over: Record<string, Record<string, ReturnType<typeof vi.fn>>> = {}) =>
    ({
        // The tick's select and the meter's per-machine read share this table; the stub answers both.
        hostedMachine: {
            findMany: vi.fn(async ({ where }: { where: { sandbox?: { ownerId: string } } }) =>
                where.sandbox === undefined ? rows : rows.filter((row) => row.sandbox.ownerId === where.sandbox?.ownerId),
            ),
            findUnique: vi.fn(async ({ where }: { where: { sandboxId: string } }) => rows.find((row) => row.sandboxId === where.sandboxId) ?? null),
        },
        hostedUsage: { findUnique: vi.fn().mockResolvedValue(null) },
        hostedPlan: { findUnique: vi.fn().mockResolvedValue(null) },
        // In good standing unless a test says otherwise; the tick reads the owner's row before the meter.
        user: { findUnique: vi.fn().mockResolvedValue({ hostedSuspendedAt: null }) },
        ...over,
    }) as unknown as PrismaClient;

// Fly's read of the machine, plus a recorder for the stop the tick may follow it with.
const stubFly = (state: string) => {
    const calls: { method: string; url: string }[] = [];
    vi.stubGlobal(`fetch`, (url: URL | string, init?: RequestInit) => {
        calls.push({ method: init?.method ?? `GET`, url: String(url) });
        return Promise.resolve(new Response(JSON.stringify({ id: `m1`, state })));
    });
    return calls;
};

const stops = (calls: { method: string; url: string }[]) => calls.filter((call) => call.method === `POST` && call.url.endsWith(`/stop`));

afterEach(() => {
    vi.unstubAllGlobals();
});

describe(`the hour meter's stop`, () => {
    it(`stops a running machine whose owner is an hour past the ceiling`, async () => {
        const calls = stubFly(`started`);
        // 2,400 settled + 10 live = 2,410; ceiling 2,400 + grace 60 = 2,460 - not yet.
        const under = prismaWith([machine()], { hostedUsage: { findUnique: vi.fn().mockResolvedValue({ minutes: 2_400 }) } });
        expect(await stopOverBudgetHosted(under, config(), logger, NOW)).toEqual({ stopped: 0 });
        expect(stops(calls)).toHaveLength(0);

        // 2,450 settled + 10 live = 2,460, exactly the grace: stopped.
        const over = prismaWith([machine()], { hostedUsage: { findUnique: vi.fn().mockResolvedValue({ minutes: 2_450 }) } });
        expect(await stopOverBudgetHosted(over, config(), logger, NOW)).toEqual({ stopped: 1 });
        expect(stops(calls)).toHaveLength(1);
        expect(stops(calls)[0]?.url).toContain(`/apps/intentic-sbx-a/machines/m1/stop`);
    });

    it(`counts the open stretch itself toward the month`, async () => {
        const calls = stubFly(`started`);
        // Nothing settled, but 41 hours awake alone exceeds the 40-hour ceiling by an hour.
        const prisma = prismaWith([machine({ wokeAt: new Date(NOW.getTime() - 41 * 60 * 60_000) })]);
        expect(await stopOverBudgetHosted(prisma, config(), logger, NOW)).toEqual({ stopped: 1 });
        expect(stops(calls)).toHaveLength(1);
    });

    // A stretch belongs to the month it began in, so one still running from last month spends none of this one's.
    it(`counts nothing against this month for a stretch that began in the last`, async () => {
        const calls = stubFly(`started`);
        const prisma = prismaWith([machine({ wokeAt: new Date(`2026-07-25T12:00:00.000Z`) })]);
        expect(await stopOverBudgetHosted(prisma, config(), logger, NOW)).toEqual({ stopped: 0 });
        expect(stops(calls)).toHaveLength(0);
    });

    /* A PAID MACHINE IS NOT UNMETERED, it has a bigger month. Awake for 100 of this month's hours is past the free
     * rung's 40 and well inside Standard's, and the rung on the row is the only thing that decides which. */
    it(`judges a paid machine against its own rung's hours, not the free lane's`, async () => {
        const awake = { wokeAt: new Date(NOW.getTime() - 100 * 60 * 60_000) };
        stubFly(`started`);
        expect(await stopOverBudgetHosted(prismaWith([machine(awake)]), config(), logger, NOW)).toEqual({ stopped: 1 });

        const calls = stubFly(`started`);
        expect(await stopOverBudgetHosted(prismaWith([machine({ ...awake, tier: STANDARD.id })]), config(), logger, NOW)).toEqual({ stopped: 0 });
        expect(stops(calls)).toHaveLength(0);
    });

    // The operator's ceiling knob is the free rung's; switching it off does not make a bought rung free of its own.
    it(`keeps a paid machine metered where the free ceiling is switched off`, async () => {
        stubFly(`started`);
        const past = prismaWith([machine({ tier: STANDARD.id, wokeAt: new Date(NOW.getTime() - 300 * 60 * 60_000) })]);
        expect(await stopOverBudgetHosted(past, config({ monthlyHours: 0 }), logger, NOW)).toEqual({ stopped: 1 });
    });

    // An open wokeAt also describes a machine that stopped on its own before its stretch settled.
    it(`does not stop a machine that already stopped`, async () => {
        const calls = stubFly(`stopped`);
        const prisma = prismaWith([machine()], { hostedUsage: { findUnique: vi.fn().mockResolvedValue({ minutes: 9_000 }) } });
        expect(await stopOverBudgetHosted(prisma, config(), logger, NOW)).toEqual({ stopped: 0 });
        expect(stops(calls)).toHaveLength(0);
    });

    it(`is off for a free machine where the platform sets no ceiling, and off entirely with no lane`, async () => {
        const calls = stubFly(`started`);
        const prisma = prismaWith([machine()], { hostedUsage: { findUnique: vi.fn().mockResolvedValue({ minutes: 9_000 }) } });
        expect(await stopOverBudgetHosted(prisma, config({ monthlyHours: 0 }), logger, NOW)).toEqual({ stopped: 0 });
        expect(await stopOverBudgetHosted(prisma, config({ flyApiToken: `` }), logger, NOW)).toEqual({ stopped: 0 });
        expect(stops(calls)).toHaveLength(0);
    });

    // A suspension holds whatever the month says: a subscriber's machine, an owner with hours left, a platform with no
    // ceiling at all.
    it(`stops a suspended owner's running machine with the month untouched and the ceiling off`, async () => {
        const calls = stubFly(`started`);
        const suspended = { findUnique: vi.fn().mockResolvedValue({ hostedSuspendedAt: NOW }) };
        const prisma = prismaWith([machine()], {
            user: suspended,
            hostedPlan: { findUnique: vi.fn().mockResolvedValue({ status: `active` }) },
        });
        expect(await stopOverBudgetHosted(prisma, config({ monthlyHours: 0 }), logger, NOW)).toEqual({ stopped: 1 });
        expect(stops(calls)).toHaveLength(1);
    });

    it(`stops every spent machine in one pass, and only the spent ones`, async () => {
        const calls = stubFly(`started`);
        const spent = new Set([`s1`, `s2`]);
        const usage = vi.fn(async ({ where }: { where: { sandboxId_month: { sandboxId: string } } }) =>
            spent.has(where.sandboxId_month.sandboxId) ? { minutes: 9_000 } : { minutes: 0 },
        );
        const prisma = prismaWith(
            [
                machine(),
                machine({ id: `h2`, sandboxId: `s2`, appName: `intentic-sbx-b`, machineId: `m2` }),
                machine({ id: `h3`, sandboxId: `s3`, appName: `intentic-sbx-c`, machineId: `m3`, sandbox: { ownerId: `u2` } }),
            ],
            { hostedUsage: { findUnique: usage } },
        );
        expect(await stopOverBudgetHosted(prisma, config(), logger, NOW)).toEqual({ stopped: 2 });
        expect(stops(calls).map((call) => call.url)).toEqual([
            expect.stringContaining(`intentic-sbx-a/machines/m1/stop`),
            expect.stringContaining(`intentic-sbx-b/machines/m2/stop`),
        ]);
    });
});
