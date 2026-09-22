import { installFakeFly } from "@intentic/testing/fly-fake";
import { describe, it, expect, afterEach, mock } from "bun:test";
import { stubGlobal, unstubAllGlobals } from "@intentic/testing/bun";
import type { PrismaClient } from "@intentic/prisma";
import type { Config } from "../../config.js";
import { reapIdleHosted } from "./hosted-idle.js";
import { DAY_MS } from "../../durations.js";

const logger = { info: mock(), warn: mock(), error: mock() } as never;

const config = (over: Record<string, unknown> = {}): Config =>
    ({
        webOrigin: `https://app.test`,
        // Unconfigured mail logs the link instead of sending, so tests exercise the real send path, no Resend stub.
        email: { apiKey: ``, from: `` },
        ingress: { url: `https://ingress.sbx.test`, signingKey: `k`, zone: `sbx.test` },
        hosted: { flyApiToken: `fly`, flyOrg: `intentic`, appPrefix: `intentic-sbx`, idleDays: 21, idleWarnDays: 14, ...over },
        hostedPlan: { compEmails: `` },
    }) as unknown as Config;

const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS);

// One machine row as the sweep selects it.
const machine = (over: Record<string, unknown> = {}) => ({
    id: `h1`,
    sandboxId: `s1`,
    appName: `intentic-sbx-a`,
    machineId: `m1`,
    createdAt: daysAgo(60),
    idleWarnedAt: null,
    sandbox: { id: `s1`, name: `My sandbox`, lastSeenAt: daysAgo(30), ownerId: `u1`, owner: { email: `owner@example.test` } },
    ...over,
});

const prismaWith = (rows: ReturnType<typeof machine>[], over: Record<string, Record<string, ReturnType<typeof mock>>> = {}) =>
    ({
        hostedMachine: { findMany: mock().mockResolvedValue(rows), update: mock().mockResolvedValue({}), delete: mock().mockResolvedValue({}) },
        // Ending a machine writes two rows together (forgetHostedMachine); settled like the rest of the hosted suite.
        sandbox: { update: mock().mockResolvedValue({}) },
        $transaction: mock((operations: Promise<unknown>[]) => Promise.all(operations)),
        hostedPlan: { findUnique: mock().mockResolvedValue(null) },
        ...over,
    }) as unknown as PrismaClient;

/* The shared in-memory Fly, seeded with the one machine this sweep looks at. What these cases turn on is whether
 * the app was torn down, so the fake's own call log is the assertion and its state is the setup. */
const stubFly = (state: string) => {
    const fly = installFakeFly((name, value) => stubGlobal(name, value));
    const seeded = fly.seedSandbox(`intentic-sbx-a`);
    // The fake names its own machine; the row under test names `m1`, so this one answers to both.
    fly.machines.set(`m1`, { ...seeded.machine, id: `m1`, state });
    fly.machines.delete(seeded.machine.id);
    return fly;
};

afterEach(() => {
    unstubAllGlobals();
});

describe(`collecting the machines nobody came back to`, () => {
    it(`destroys a non-member's machine once it is past the deadline, and drops only its row`, async () => {
        const fly = stubFly(`stopped`);
        const prisma = prismaWith([machine({ idleWarnedAt: daysAgo(8) })]);
        expect(await reapIdleHosted(prisma, config(), logger)).toEqual({ warned: 0, destroyed: 1, dropped: 0 });
        expect(fly.calls.filter((entry) => entry.method === `DELETE`)).toHaveLength(1);
        expect(prisma.hostedMachine.delete).toHaveBeenCalledWith({ where: { id: `h1` } });
        // The address goes with the machine, since it was only ever the machine's; the edge would replay to a dead app.
        expect(prisma.sandbox.update).toHaveBeenCalledWith({ where: { id: `s1` }, data: { daemonUrl: null } });
    });

/* THE MINUTES GO WITH THE ROW unless they are charged first. */
    it(`charges a machine's open awake stretch to its owner's month before dropping its row`, async () => {
        stubFly(`stopped`);
        const upsert = mock().mockResolvedValue({});
        const wokeAt = daysAgo(30);
        const prisma = prismaWith([machine({ wokeAt, idleWarnedAt: daysAgo(8) })], { hostedUsage: { upsert, aggregate: mock().mockResolvedValue({ _sum: { minutes: null } }) } });
        expect(await reapIdleHosted(prisma, config(), logger)).toEqual({ warned: 0, destroyed: 1, dropped: 0 });
        expect(upsert).toHaveBeenCalledWith(
            expect.objectContaining({ where: { sandboxId_month: { sandboxId: `s1`, month: wokeAt.toISOString().slice(0, 7) } } }),
        );
        const deleteCall = (prisma.hostedMachine.delete as ReturnType<typeof mock>).mock.invocationCallOrder[0]!;
        expect(upsert.mock.invocationCallOrder[0]).toBeLessThan(deleteCall);
    });

/* A provider-deleted machine must not leave a hosted row behind. */
    it(`drops the row of a machine Fly no longer has, whatever the clock says about it`, async () => {
        stubGlobal(`fetch`, () => Promise.resolve(new Response(JSON.stringify({ error: `machine not found` }), { status: 404 })));
        const prisma = prismaWith([machine({ sandbox: { ...machine().sandbox, lastSeenAt: daysAgo(15) } })]);
        expect(await reapIdleHosted(prisma, config(), logger)).toEqual({ warned: 0, destroyed: 0, dropped: 1 });
        expect(prisma.hostedMachine.delete).toHaveBeenCalledWith({ where: { id: `h1` } });
        expect(prisma.sandbox.update).toHaveBeenCalledWith({ where: { id: `s1` }, data: { daemonUrl: null } });
    });

    it(`warns once inside the notice period and destroys nothing`, async () => {
        const fly = stubFly(`stopped`);
        const prisma = prismaWith([machine({ sandbox: { ...machine().sandbox, lastSeenAt: daysAgo(15) } })]);
        expect(await reapIdleHosted(prisma, config(), logger)).toEqual({ warned: 1, destroyed: 0, dropped: 0 });
        expect(fly.calls.filter((entry) => entry.method === `DELETE`)).toHaveLength(0);
        expect(prisma.hostedMachine.update).toHaveBeenCalledWith({ where: { id: `h1` }, data: { idleWarnedAt: expect.any(Date) } });
    });

    it(`does not warn a second time while the first notice stands`, async () => {
        stubFly(`stopped`);
        const prisma = prismaWith([machine({ idleWarnedAt: daysAgo(1), sandbox: { ...machine().sandbox, lastSeenAt: daysAgo(15) } })]);
        expect(await reapIdleHosted(prisma, config(), logger)).toEqual({ warned: 0, destroyed: 0, dropped: 0 });
        expect(prisma.hostedMachine.update).not.toHaveBeenCalled();
    });

    /* LOWERING idleDays MUST NOT COLLECT WHAT IT HAS NEVER WARNED. A machine sitting between the old threshold
     * and a tighter new one is past the deadline the first time the sweep sees it, and the destroy branch used
     * to be reached on the clock alone — so the mail promising notice was never sent and the owner's first news
     * was an empty sandbox. It is warned instead, and collected a notice period later. */
    it(`warns a machine already past the deadline rather than collecting one nobody was told about`, async () => {
        const fly = stubFly(`stopped`);
        const prisma = prismaWith([machine({ sandbox: { ...machine().sandbox, lastSeenAt: daysAgo(40) } })]);
        expect(await reapIdleHosted(prisma, config(), logger)).toEqual({ warned: 1, destroyed: 0, dropped: 0 });
        expect(fly.calls.filter((entry) => entry.method === `DELETE`)).toHaveLength(0);
        expect(prisma.hostedMachine.update).toHaveBeenCalledWith({ where: { id: `h1` }, data: { idleWarnedAt: expect.any(Date) } });
    });

    // The notice has to have STOOD for the notice period (21 - 14 here), not merely to have been sent at some point.
    it(`holds a machine past the deadline while its notice is younger than the notice period`, async () => {
        const fly = stubFly(`stopped`);
        const prisma = prismaWith([machine({ idleWarnedAt: daysAgo(2) })]);
        expect(await reapIdleHosted(prisma, config(), logger)).toEqual({ warned: 0, destroyed: 0, dropped: 0 });
        expect(fly.calls.filter((entry) => entry.method === `DELETE`)).toHaveLength(0);
    });

    it(`never touches a member's machine`, async () => {
        const fly = stubFly(`stopped`);
        const prisma = prismaWith([machine()], { hostedPlan: { findUnique: mock().mockResolvedValue({ status: `active`, items: [] }) } });
        expect(await reapIdleHosted(prisma, config(), logger)).toEqual({ warned: 0, destroyed: 0, dropped: 0 });
        expect(fly.calls).toHaveLength(0);
    });

    // lastSeenAt is the daemon's boot announce, not a heartbeat; a long-lived machine looks stale but runs fine.
    it(`spares a machine that is actually running, however stale its last announce`, async () => {
        const fly = stubFly(`started`);
        const prisma = prismaWith([machine({ idleWarnedAt: daysAgo(2) })]);
        expect(await reapIdleHosted(prisma, config(), logger)).toEqual({ warned: 0, destroyed: 0, dropped: 0 });
        expect(fly.calls.filter((entry) => entry.method === `DELETE`)).toHaveLength(0);
        // Notice is withdrawn too, so a full warning period runs again whenever it does stop.
        expect(prisma.hostedMachine.update).toHaveBeenCalledWith({ where: { id: `h1` }, data: { idleWarnedAt: null } });
    });

    it(`measures a machine that never announced from when it was created`, async () => {
        stubFly(`stopped`);
        const prisma = prismaWith([machine({ createdAt: daysAgo(40), idleWarnedAt: daysAgo(8), sandbox: { ...machine().sandbox, lastSeenAt: null } })]);
        expect(await reapIdleHosted(prisma, config(), logger)).toEqual({ warned: 0, destroyed: 1, dropped: 0 });
    });

    it(`leaves a machine inside the notice period alone entirely`, async () => {
        const fly = stubFly(`stopped`);
        const prisma = prismaWith([machine({ createdAt: daysAgo(5), sandbox: { ...machine().sandbox, lastSeenAt: daysAgo(5) } })]);
        expect(await reapIdleHosted(prisma, config(), logger)).toEqual({ warned: 0, destroyed: 0, dropped: 0 });
        expect(fly.calls).toHaveLength(0);
    });

    // Either day at zero switches the whole sweep off.
    it(`does nothing when the sweep is disabled`, async () => {
        const prisma = prismaWith([machine()]);
        expect(await reapIdleHosted(prisma, config({ idleDays: 0 }), logger)).toEqual({ warned: 0, destroyed: 0, dropped: 0 });
        expect(prisma.hostedMachine.findMany).not.toHaveBeenCalled();
    });

    it(`carries on past a machine that fails, and still collects the others`, async () => {
        let first = true;
        stubGlobal(`fetch`, (url: URL | string, init?: RequestInit) => {
            if (first) {
                first = false;
                return Promise.reject(new Error(`fly is having a day`));
            }
            return (init?.method ?? `GET`) === `DELETE`
                ? Promise.resolve(new Response(``, { status: 202 }))
                : Promise.resolve(new Response(JSON.stringify({ id: `m2`, state: `stopped` })));
        });
        const prisma = prismaWith([machine({ idleWarnedAt: daysAgo(8) }), machine({ id: `h2`, appName: `intentic-sbx-b`, idleWarnedAt: daysAgo(8) })]);
        expect(await reapIdleHosted(prisma, config(), logger)).toEqual({ warned: 0, destroyed: 1, dropped: 0 });
        expect(prisma.hostedMachine.delete).toHaveBeenCalledWith({ where: { id: `h2` } });
    });
});
