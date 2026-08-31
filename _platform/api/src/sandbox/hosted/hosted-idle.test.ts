import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@intentic-app/prisma";
import type { Config } from "../../config.js";
import { reapIdleHosted } from "./hosted-idle.js";

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

const config = (over: Record<string, unknown> = {}): Config =>
    ({
        webOrigin: `https://app.test`,
        // Unconfigured mail logs the link instead of sending, so these tests exercise the real send path's
        // ordering without a network stub standing in for Resend.
        email: { apiKey: ``, from: `` },
        ingress: { url: `https://ingress.sbx.test`, signingKey: `k`, zone: `sbx.test` },
        hosted: { flyApiToken: `fly`, flyOrg: `intentic`, appPrefix: `intentic-sbx`, idleDays: 21, idleWarnDays: 14, ...over },
        pool: { compEmails: `` },
    }) as unknown as Config;

const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS);

// One machine row as the sweep selects it.
const machine = (over: Record<string, unknown> = {}) => ({
    id: `h1`,
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
        membership: { findUnique: vi.fn().mockResolvedValue(null) },
        ...over,
    }) as unknown as PrismaClient;

// Fly's read of the machine, plus a recorder for the app teardown the sweep may follow it with.
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
        const prisma = prismaWith([machine()]);
        expect(await reapIdleHosted(prisma, config(), logger)).toEqual({ warned: 0, destroyed: 1, dropped: 0 });
        expect(calls.filter((entry) => entry.method === `DELETE`)).toHaveLength(1);
        // The MACHINE row goes; the sandbox is untouched, so its name, address and sharing survive and its
        // owner can give it a new machine rather than finding the workspace itself gone.
        expect(prisma.hostedMachine.delete).toHaveBeenCalledWith({ where: { id: `h1` } });
    });

    /* THE ROW THAT OUTLIVED ITS MACHINE, and the reason this sweep threw every night for weeks: a machine
     * destroyed provider-side (here, by a second deployment's orphan sweep) left a row that could never be
     * read again. The row is not inert, `hostedOffer` counts rows against the one-machine allowance, so its
     * owner could not be given a replacement either. Dropping it is the whole fix, and it is safe for the same
     * reason a collection is: the SANDBOX stays. */
    it(`drops the row of a machine Fly no longer has, whatever the clock says about it`, async () => {
        vi.stubGlobal(`fetch`, () => Promise.resolve(new Response(JSON.stringify({ error: `machine not found` }), { status: 404 })));
        const prisma = prismaWith([machine({ sandbox: { ...machine().sandbox, lastSeenAt: daysAgo(15) } })]);
        expect(await reapIdleHosted(prisma, config(), logger)).toEqual({ warned: 0, destroyed: 0, dropped: 1 });
        expect(prisma.hostedMachine.delete).toHaveBeenCalledWith({ where: { id: `h1` } });
    });

    it(`warns once inside the notice period and destroys nothing`, async () => {
        const calls = stubFly(`stopped`);
        const prisma = prismaWith([machine({ sandbox: { ...machine().sandbox, lastSeenAt: daysAgo(15) } })]);
        expect(await reapIdleHosted(prisma, config(), logger)).toEqual({ warned: 1, destroyed: 0, dropped: 0 });
        expect(calls.filter((entry) => entry.method === `DELETE`)).toHaveLength(0);
        expect(prisma.hostedMachine.update).toHaveBeenCalledWith({ where: { id: `h1` }, data: { idleWarnedAt: expect.any(Date) } });
    });

    // The stamp is what stops one warning becoming seven: the sweep runs daily across the whole notice period.
    it(`does not warn a second time while the first notice stands`, async () => {
        stubFly(`stopped`);
        const prisma = prismaWith([machine({ idleWarnedAt: daysAgo(1), sandbox: { ...machine().sandbox, lastSeenAt: daysAgo(15) } })]);
        expect(await reapIdleHosted(prisma, config(), logger)).toEqual({ warned: 0, destroyed: 0, dropped: 0 });
        expect(prisma.hostedMachine.update).not.toHaveBeenCalled();
    });

    /* Membership is what is being sold; it is not an alarm clock. A member's machine is never collected
     * however long it sits, which is also what makes "your data stays" a real difference between the tiers. */
    it(`never touches a member's machine`, async () => {
        const calls = stubFly(`stopped`);
        const prisma = prismaWith([machine()], { membership: { findUnique: vi.fn().mockResolvedValue({ status: `active` }) } });
        expect(await reapIdleHosted(prisma, config(), logger)).toEqual({ warned: 0, destroyed: 0, dropped: 0 });
        expect(calls).toHaveLength(0);
    });

    /* THE FALSE POSITIVE THIS SWEEP EXISTS TO AVOID. `lastSeenAt` is the daemon's BOOT announce, so a machine
     * that has been up for a month (a long-lived dev server, a job nobody restarted) looks untouched while
     * being exactly the opposite. Fly is asked before anything is destroyed. */
    it(`spares a machine that is actually running, however stale its last announce`, async () => {
        const calls = stubFly(`started`);
        const prisma = prismaWith([machine({ idleWarnedAt: daysAgo(2) })]);
        expect(await reapIdleHosted(prisma, config(), logger)).toEqual({ warned: 0, destroyed: 0, dropped: 0 });
        expect(calls.filter((entry) => entry.method === `DELETE`)).toHaveLength(0);
        // And its notice is withdrawn, so a full warning period runs again whenever it does stop.
        expect(prisma.hostedMachine.update).toHaveBeenCalledWith({ where: { id: `h1` }, data: { idleWarnedAt: null } });
    });

    // A machine that never announced at all is measured from its own creation: a provision that failed to come
    // up and was then abandoned is exactly the case that leaves a disk billing for nothing.
    it(`measures a machine that never announced from when it was created`, async () => {
        stubFly(`stopped`);
        const prisma = prismaWith([machine({ createdAt: daysAgo(40), sandbox: { ...machine().sandbox, lastSeenAt: null } })]);
        expect(await reapIdleHosted(prisma, config(), logger)).toEqual({ warned: 0, destroyed: 1, dropped: 0 });
    });

    it(`leaves a machine inside the notice period alone entirely`, async () => {
        const calls = stubFly(`stopped`);
        const prisma = prismaWith([machine({ createdAt: daysAgo(5), sandbox: { ...machine().sandbox, lastSeenAt: daysAgo(5) } })]);
        expect(await reapIdleHosted(prisma, config(), logger)).toEqual({ warned: 0, destroyed: 0, dropped: 0 });
        expect(calls).toHaveLength(0);
    });

    // Either day at zero switches the whole thing off: the setting a platform that collects nothing uses.
    it(`does nothing when the sweep is disabled`, async () => {
        const prisma = prismaWith([machine()]);
        expect(await reapIdleHosted(prisma, config({ idleDays: 0 }), logger)).toEqual({ warned: 0, destroyed: 0, dropped: 0 });
        expect(prisma.hostedMachine.findMany).not.toHaveBeenCalled();
    });

    // One machine's failure must not cost the rest of the sweep; the next day retries it.
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
        const prisma = prismaWith([machine(), machine({ id: `h2`, appName: `intentic-sbx-b` })]);
        expect(await reapIdleHosted(prisma, config(), logger)).toEqual({ warned: 0, destroyed: 1, dropped: 0 });
        expect(prisma.hostedMachine.delete).toHaveBeenCalledWith({ where: { id: `h2` } });
    });
});
