import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@intentic/prisma";
import type { Config } from "../../config.js";
import { stopOverBudgetHosted } from "./hosted-meter.js";

/* THE METER'S BACKSTOP. Forty free hours used to mean forty hours of STOPPING: a machine kept awake from the
 * inside was never settled and so never charged. The tick reads the open stretch live and stops a metered
 * owner's running machines once the month is spent by more than the grace, and only then; a subscriber, an
 * owner under the ceiling, and a machine that already stopped on its own are all left alone. */

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

const NOW = new Date(`2026-08-13T12:00:00.000Z`);

const config = (over: Record<string, unknown> = {}): Config =>
    ({
        // The lane is on only with its credential AND the edge (hostedEnabled), the same pair the idle sweep's fixture carries.
        ingress: { url: `https://ingress.sbx.test`, signingKey: `k`, zone: `sbx.test` },
        hosted: { flyApiToken: `fly`, flyOrg: `intentic`, monthlyHours: 40, overBudgetGraceMinutes: 60, ...over },
        hostedPlan: { compEmails: `` },
    }) as unknown as Config;

// One machine with an open stretch, as the tick selects it.
const machine = (over: Record<string, unknown> = {}) => ({
    id: `h1`,
    appName: `intentic-sbx-a`,
    machineId: `m1`,
    wokeAt: new Date(NOW.getTime() - 10 * 60_000),
    sandbox: { ownerId: `u1` },
    ...over,
});

const prismaWith = (rows: ReturnType<typeof machine>[], over: Record<string, Record<string, ReturnType<typeof vi.fn>>> = {}) =>
    ({
        // The tick's own select (every open stretch) and the meter's live read (one owner's) share the table;
        // the stub honours the owner filter so a spent owner's minutes never land on somebody else's month.
        hostedMachine: {
            findMany: vi.fn(async ({ where }: { where: { sandbox?: { ownerId: string } } }) =>
                where.sandbox === undefined ? rows : rows.filter((row) => row.sandbox.ownerId === where.sandbox?.ownerId),
            ),
        },
        hostedUsage: { findUnique: vi.fn().mockResolvedValue(null) },
        hostedPlan: { findUnique: vi.fn().mockResolvedValue(null) },
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
        // 2,400 settled + 10 live = 2,410; ceiling 2,400 + grace 60 = 2,460. Not yet.
        const under = prismaWith([machine()], { hostedUsage: { findUnique: vi.fn().mockResolvedValue({ minutes: 2_400 }) } });
        expect(await stopOverBudgetHosted(under, config(), logger, NOW)).toEqual({ stopped: 0 });
        expect(stops(calls)).toHaveLength(0);

        // 2,450 settled + 10 live = 2,460. Exactly the grace: stopped.
        const over = prismaWith([machine()], { hostedUsage: { findUnique: vi.fn().mockResolvedValue({ minutes: 2_450 }) } });
        expect(await stopOverBudgetHosted(over, config(), logger, NOW)).toEqual({ stopped: 1 });
        expect(stops(calls)).toHaveLength(1);
        expect(stops(calls)[0]?.url).toContain(`/apps/intentic-sbx-a/machines/m1/stop`);
    });

    it(`counts the open stretch itself toward the month`, async () => {
        const calls = stubFly(`started`);
        // Nothing settled, but the machine has been awake 41 hours: spent by an hour on the live figure alone.
        const prisma = prismaWith([machine({ wokeAt: new Date(NOW.getTime() - 41 * 60 * 60_000) })]);
        expect(await stopOverBudgetHosted(prisma, config(), logger, NOW)).toEqual({ stopped: 1 });
        expect(stops(calls)).toHaveLength(1);
    });

    it(`never touches a subscriber's machine`, async () => {
        const calls = stubFly(`started`);
        const prisma = prismaWith([machine({ wokeAt: new Date(NOW.getTime() - 400 * 60 * 60_000) })], {
            hostedPlan: { findUnique: vi.fn().mockResolvedValue({ status: `active` }) },
        });
        expect(await stopOverBudgetHosted(prisma, config(), logger, NOW)).toEqual({ stopped: 0 });
        expect(stops(calls)).toHaveLength(0);
    });

    // An open `wokeAt` is also what a machine that stopped on its own looks like until it is settled.
    it(`does not stop a machine that already stopped`, async () => {
        const calls = stubFly(`stopped`);
        const prisma = prismaWith([machine()], { hostedUsage: { findUnique: vi.fn().mockResolvedValue({ minutes: 9_000 }) } });
        expect(await stopOverBudgetHosted(prisma, config(), logger, NOW)).toEqual({ stopped: 0 });
        expect(stops(calls)).toHaveLength(0);
    });

    it(`is off where the platform has no ceiling or no lane`, async () => {
        const calls = stubFly(`started`);
        const prisma = prismaWith([machine()], { hostedUsage: { findUnique: vi.fn().mockResolvedValue({ minutes: 9_000 }) } });
        expect(await stopOverBudgetHosted(prisma, config({ monthlyHours: 0 }), logger, NOW)).toEqual({ stopped: 0 });
        expect(await stopOverBudgetHosted(prisma, config({ flyApiToken: `` }), logger, NOW)).toEqual({ stopped: 0 });
        expect(stops(calls)).toHaveLength(0);
    });

    // One owner's several machines go together: the month is one number, and stopping one an hour would be
    // a slower version of the same decision.
    it(`stops every running machine of a spent owner in one pass, and only theirs`, async () => {
        const calls = stubFly(`started`);
        const usage = vi.fn(async ({ where }: { where: { userId_month: { userId: string } } }) =>
            where.userId_month.userId === `u1` ? { minutes: 9_000 } : { minutes: 0 },
        );
        const prisma = prismaWith(
            [machine(), machine({ id: `h2`, appName: `intentic-sbx-b`, machineId: `m2` }), machine({ id: `h3`, appName: `intentic-sbx-c`, machineId: `m3`, sandbox: { ownerId: `u2` } })],
            { hostedUsage: { findUnique: usage } },
        );
        expect(await stopOverBudgetHosted(prisma, config(), logger, NOW)).toEqual({ stopped: 2 });
        expect(stops(calls).map((call) => call.url)).toEqual([
            expect.stringContaining(`intentic-sbx-a/machines/m1/stop`),
            expect.stringContaining(`intentic-sbx-b/machines/m2/stop`),
        ]);
    });
});
