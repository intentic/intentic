import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@intentic/prisma";
import type { Config } from "../../config.js";
import { reapIdleHosted } from "./hosted-idle.js";
import { DAY_MS } from "../../durations.js";

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

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

const prismaWith = (rows: ReturnType<typeof machine>[], over: Record<string, Record<string, ReturnType<typeof vi.fn>>> = {}) =>
    ({
        hostedMachine: { findMany: vi.fn().mockResolvedValue(rows), update: vi.fn().mockResolvedValue({}), delete: vi.fn().mockResolvedValue({}) },
        // Ending a machine writes two rows together (forgetHostedMachine); settled like the rest of the hosted suite.
        sandbox: { update: vi.fn().mockResolvedValue({}) },
        $transaction: vi.fn((operations: Promise<unknown>[]) => Promise.all(operations)),
        hostedPlan: { findUnique: vi.fn().mockResolvedValue(null) },
        ...over,
    }) as unknown as PrismaClient;

// Fly's read of the machine, plus a recorder for any app-teardown call the sweep follows it with.
const stubFly = (state: string) => {
    const calls: { method: string; url: string }[] = [];
    vi.stubGlobal(`fetch`, (url: URL | string, init?: RequestInit) => {
        calls.push({ method: init?.method ?? `GET`, url: String(url) });
        if ((init?.method ?? `GET`) === `DELETE`) {
            return Promise.resolve(new Response(``, { status: 202 }));
        }
        return Promise.resolve(new Response(JSON.stringify({ id: `m1`, state })));
    });
    return calls;
};

afterEach(() => {
    vi.unstubAllGlobals();
});

describe(`collecting the machines nobody came back to`, () => {
    it(`destroys a non-member's machine once it is past the deadline, and drops only its row`, async () => {
        const calls = stubFly(`stopped`);
        const prisma = prismaWith([machine({ idleWarnedAt: daysAgo(8) })]);
        expect(await reapIdleHosted(prisma, config(), logger)).toEqual({ warned: 0, destroyed: 1, dropped: 0 });
        expect(calls.filter((entry) => entry.method === `DELETE`)).toHaveLength(1);
        expect(prisma.hostedMachine.delete).toHaveBeenCalledWith({ where: { id: `h1` } });
        // The address goes with the machine, since it was only ever the machine's; the edge would replay to a dead app.
        expect(prisma.sandbox.update).toHaveBeenCalledWith({ where: { id: `s1` }, data: { daemonUrl: null } });
    });

/* THE MINUTES GO WITH THE ROW unless they are charged first. */
    it(`charges a machine's open awake stretch to its owner's month before dropping its row`, async () => {
        stubFly(`stopped`);
        const upsert = vi.fn().mockResolvedValue({});
        const wokeAt = daysAgo(30);
        const prisma = prismaWith([machine({ wokeAt, idleWarnedAt: daysAgo(8) })], { hostedUsage: { upsert, aggregate: vi.fn().mockResolvedValue({ _sum: { minutes: null } }) } });
        expect(await reapIdleHosted(prisma, config(), logger)).toEqual({ warned: 0, destroyed: 1, dropped: 0 });
        expect(upsert).toHaveBeenCalledWith(
            expect.objectContaining({ where: { sandboxId_month: { sandboxId: `s1`, month: wokeAt.toISOString().slice(0, 7) } } }),
        );
        const deleteCall = (prisma.hostedMachine.delete as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!;
        expect(upsert.mock.invocationCallOrder[0]).toBeLessThan(deleteCall);
    });

/* A provider-deleted machine must not leave a hosted row behind. */
    it(`drops the row of a machine Fly no longer has, whatever the clock says about it`, async () => {
        vi.stubGlobal(`fetch`, () => Promise.resolve(new Response(JSON.stringify({ error: `machine not found` }), { status: 404 })));
        const prisma = prismaWith([machine({ sandbox: { ...machine().sandbox, lastSeenAt: daysAgo(15) } })]);
        expect(await reapIdleHosted(prisma, config(), logger)).toEqual({ warned: 0, destroyed: 0, dropped: 1 });
        expect(prisma.hostedMachine.delete).toHaveBeenCalledWith({ where: { id: `h1` } });
        expect(prisma.sandbox.update).toHaveBeenCalledWith({ where: { id: `s1` }, data: { daemonUrl: null } });
    });

    it(`warns once inside the notice period and destroys nothing`, async () => {
        const calls = stubFly(`stopped`);
        const prisma = prismaWith([machine({ sandbox: { ...machine().sandbox, lastSeenAt: daysAgo(15) } })]);
        expect(await reapIdleHosted(prisma, config(), logger)).toEqual({ warned: 1, destroyed: 0, dropped: 0 });
        expect(calls.filter((entry) => entry.method === `DELETE`)).toHaveLength(0);
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
        const calls = stubFly(`stopped`);
        const prisma = prismaWith([machine({ sandbox: { ...machine().sandbox, lastSeenAt: daysAgo(40) } })]);
        expect(await reapIdleHosted(prisma, config(), logger)).toEqual({ warned: 1, destroyed: 0, dropped: 0 });
        expect(calls.filter((entry) => entry.method === `DELETE`)).toHaveLength(0);
        expect(prisma.hostedMachine.update).toHaveBeenCalledWith({ where: { id: `h1` }, data: { idleWarnedAt: expect.any(Date) } });
    });

    // The notice has to have STOOD for the notice period (21 - 14 here), not merely to have been sent at some point.
    it(`holds a machine past the deadline while its notice is younger than the notice period`, async () => {
        const calls = stubFly(`stopped`);
        const prisma = prismaWith([machine({ idleWarnedAt: daysAgo(2) })]);
        expect(await reapIdleHosted(prisma, config(), logger)).toEqual({ warned: 0, destroyed: 0, dropped: 0 });
        expect(calls.filter((entry) => entry.method === `DELETE`)).toHaveLength(0);
    });

    it(`never touches a member's machine`, async () => {
        const calls = stubFly(`stopped`);
        const prisma = prismaWith([machine()], { hostedPlan: { findUnique: vi.fn().mockResolvedValue({ status: `active`, items: [] }) } });
        expect(await reapIdleHosted(prisma, config(), logger)).toEqual({ warned: 0, destroyed: 0, dropped: 0 });
        expect(calls).toHaveLength(0);
    });

    // lastSeenAt is the daemon's boot announce, not a heartbeat; a long-lived machine looks stale but runs fine.
    it(`spares a machine that is actually running, however stale its last announce`, async () => {
        const calls = stubFly(`started`);
        const prisma = prismaWith([machine({ idleWarnedAt: daysAgo(2) })]);
        expect(await reapIdleHosted(prisma, config(), logger)).toEqual({ warned: 0, destroyed: 0, dropped: 0 });
        expect(calls.filter((entry) => entry.method === `DELETE`)).toHaveLength(0);
        // Notice is withdrawn too, so a full warning period runs again whenever it does stop.
        expect(prisma.hostedMachine.update).toHaveBeenCalledWith({ where: { id: `h1` }, data: { idleWarnedAt: null } });
    });

    it(`measures a machine that never announced from when it was created`, async () => {
        stubFly(`stopped`);
        const prisma = prismaWith([machine({ createdAt: daysAgo(40), idleWarnedAt: daysAgo(8), sandbox: { ...machine().sandbox, lastSeenAt: null } })]);
        expect(await reapIdleHosted(prisma, config(), logger)).toEqual({ warned: 0, destroyed: 1, dropped: 0 });
    });

    it(`leaves a machine inside the notice period alone entirely`, async () => {
        const calls = stubFly(`stopped`);
        const prisma = prismaWith([machine({ createdAt: daysAgo(5), sandbox: { ...machine().sandbox, lastSeenAt: daysAgo(5) } })]);
        expect(await reapIdleHosted(prisma, config(), logger)).toEqual({ warned: 0, destroyed: 0, dropped: 0 });
        expect(calls).toHaveLength(0);
    });

    // Either day at zero switches the whole sweep off.
    it(`does nothing when the sweep is disabled`, async () => {
        const prisma = prismaWith([machine()]);
        expect(await reapIdleHosted(prisma, config({ idleDays: 0 }), logger)).toEqual({ warned: 0, destroyed: 0, dropped: 0 });
        expect(prisma.hostedMachine.findMany).not.toHaveBeenCalled();
    });

    it(`carries on past a machine that fails, and still collects the others`, async () => {
        let first = true;
        vi.stubGlobal(`fetch`, (url: URL | string, init?: RequestInit) => {
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
