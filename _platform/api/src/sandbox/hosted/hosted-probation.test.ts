import { stubGlobal, unstubAllGlobals } from "@intentic/testing/bun";
import { type FakeFly, installFakeFly } from "@intentic/testing/fly-fake";
import { UPDATE_PROBATION } from "@intentic/sandbox-contract/state/update-probation";
import type { Config } from "../../config.js";
import { MINUTE_MS } from "../../durations.js";
import { fakeHostedAppLock, healthAnswer, machineAnswers, NO_HEALTH } from "../../testing.js";
import { HostedImageKept, HostedMachineBusy } from "./gate/state-gate.js";
import { PROBATION_ENDS } from "./gate/gate-row.js";
import { HostedNothingKept } from "./hosted.js";
import { type ProbationCandidate, sweepHostedProbation, watchHostedMachine } from "./hosted-probation.js";
import * as hostedOriginal from "./hosted.js";
import * as hostedUsageOriginal from "./hosted-usage.js";

/* THE POST-SWITCH PROBATION WATCH applies the contract's rule to a hosted machine's new image. The rule itself is held to ic's
 * Rust by golden/update-probation.json (the contract's own suite); these hold what the platform does with its verdicts: which
 * machines it looks at, what a look is, what it writes, and when it puts the earlier image back. */

jest.mock(`./hosted-app-lock.js`, () => ({ withHostedAppLock: fakeHostedAppLock }));
// The rollback is the gate's (state-gate.test.ts and hosted.test.ts hold it to the machine); here it is a call to count.
const rollbackHosted = jest.fn(async (..._args: unknown[]): Promise<void> => undefined);
jest.mock(`./hosted.js`, () => ({ ...hostedOriginal, rollbackHosted }));
// The owner has hours to spend unless a case says otherwise.
const hostedBudgetOf = jest.fn(async (..._args: unknown[]): Promise<{ metered: boolean; remainingMinutes: number }> => ({ metered: false, remainingMinutes: 600 }));
const settleHostedStretch = jest.fn(async (..._args: unknown[]): Promise<void> => undefined);
const openHostedStretch = jest.fn(async (..._args: unknown[]): Promise<boolean> => true);
jest.mock(`./hosted-usage.js`, () => ({ ...hostedUsageOriginal, hostedBudgetOf, settleHostedStretch, openHostedStretch }));

// SAFETY: the watch reads only the Fly token and the secrets key off the config.
const config = { hosted: { flyApiToken: `fly` }, secrets: { key: `` } } as Config;
const warned = jest.fn();
const errored = jest.fn();
// SAFETY: the watch calls only these three methods of its logger.
const logger = { info: jest.fn(), warn: warned, error: errored } as never;

const NOW = Date.parse(`2026-10-12T12:00:00Z`);
const OLD = `ghcr.io/intentic/sandbox@sha256:${`a`.repeat(64)}`;
const NEW = `ghcr.io/intentic/sandbox@sha256:${`b`.repeat(64)}`;

// A machine whose new image came up `minutes` ago, with the one before it kept and `strikes` failed looks behind it.
const candidate = (minutes: number, over: Partial<ProbationCandidate> = {}): ProbationCandidate => ({
    id: `h1`,
    sandboxId: `s1`,
    appName: `intentic-sbx-a`,
    machineId: `m1`,
    volumeId: `vol_1`,
    region: `iad`,
    tier: `free`,
    cpuKind: `shared`,
    cpus: 2,
    memoryMb: 4096,
    volumeGb: 10,
    wokeAt: null,
    image: null,
    baseDigest: null,
    environmentHash: null,
    previousImage: OLD,
    previousEnvironmentHash: null,
    unprovenImage: null,
    probationSince: new Date(NOW - minutes * MINUTE_MS),
    probationStrikes: 0,
    sandbox: { token: `connect-token`, ownerId: `u1`, owner: { email: `owner@test.dev` } },
    ...over,
});

// The machine on Fly, started `startedMinutes` ago (Fly's own last-transition stamp), answering as `answers` says.
const seeded = (state: string, startedMinutes: number, answers: ReturnType<typeof machineAnswers>): FakeFly => {
    const fly = installFakeFly((name, value) => stubGlobal(name, value));
    fly.apps.add(`intentic-sbx-a`);
    const at = new Date(NOW - startedMinutes * MINUTE_MS).toISOString();
    fly.machines.set(`m1`, { id: `m1`, app: `intentic-sbx-a`, region: `iad`, state, config: { image: NEW, env: {} }, createdAt: at, updatedAt: at });
    fly.commands.answer = answers;
    return fly;
};
const HEALTHY = machineAnswers({});
const SILENT = machineAnswers({ health: () => NO_HEALTH });
const JOURNAL_FAILED = machineAnswers({ health: () => healthAnswer({ boot: { ready: true }, state: { journal: `failed` } }) });
const LOOPING = machineAnswers({
    health: () => NO_HEALTH,
    vitals: () => ({ exit_code: 0, stdout: JSON.stringify({ node: `restarting`, lagMs: null, restarts: 3, uptimeS: 41, pressure: null }), stderr: `` }),
});

// The machine's row, as the watch reads it again before it acts and writes to it.
const prismaOf = (row: Partial<ProbationCandidate> = {}) => {
    const held = candidate(60, row);
    const prisma = {
        hostedMachine: {
            findMany: jest.fn(async () => [held]),
            findUnique: jest.fn(async () => ({ probationSince: held.probationSince, previousImage: held.previousImage, unprovenImage: held.unprovenImage })),
            update: jest.fn(async () => held),
        },
    };
    // SAFETY: the watch calls only these three methods of the machine table.
    return { prisma: prisma as never, table: prisma.hostedMachine };
};

afterEach(() => {
    unstubAllGlobals();
    jest.clearAllMocks();
});

describe(`a look at a machine on probation`, () => {
    it(`finds a healthy image healthy, and a strike already standing starts over`, async () => {
        seeded(`started`, 60, HEALTHY);
        const { prisma, table } = prismaOf();
        const outcome = await watchHostedMachine(prisma, config, logger, candidate(60, { probationStrikes: 2 }), NOW);
        expect(outcome).toEqual({ kind: `watching`, strikes: 0 });
        expect(table.update).toHaveBeenCalledWith({ where: { id: `h1` }, data: { probationStrikes: 0 } });
        expect(rollbackHosted).not.toHaveBeenCalled();
    });

    it(`writes nothing when nothing moved`, async () => {
        seeded(`started`, 60, HEALTHY);
        const { prisma, table } = prismaOf();
        await watchHostedMachine(prisma, config, logger, candidate(60), NOW);
        expect(table.update).not.toHaveBeenCalled();
    });

    it(`waits out a daemon that is silent inside the grace, and counts it past it`, async () => {
        seeded(`started`, 60, SILENT);
        const { prisma, table } = prismaOf();
        const grace = UPDATE_PROBATION.graceMs / MINUTE_MS;
        expect(await watchHostedMachine(prisma, config, logger, candidate(grace - 1), NOW)).toEqual({ kind: `watching`, strikes: 0 });
        expect(table.update).not.toHaveBeenCalled();
        expect(await watchHostedMachine(prisma, config, logger, candidate(grace), NOW)).toEqual({
            kind: `watching`,
            strikes: 1,
            reason: `the new version's daemon is not answering`,
        });
        expect(table.update).toHaveBeenCalledWith({ where: { id: `h1` }, data: { probationStrikes: 1 } });
    });

    it(`goes back on the third failed look in a row, the way the owner's press does, without a probation of its own`, async () => {
        const fly = seeded(`started`, 60, SILENT);
        const { prisma } = prismaOf({ probationStrikes: UPDATE_PROBATION.strikes - 1 });
        const machine = candidate(60, { probationStrikes: UPDATE_PROBATION.strikes - 1 });
        const outcome = await watchHostedMachine(prisma, config, logger, machine, NOW);
        expect(outcome).toEqual({ kind: `rolled-back`, reason: `the new version's daemon is not answering` });
        // The machine is stopped and its stretch settled first, as the route does, then the gate puts the earlier image back.
        expect(fly.called(`POST`, `/machines/m1/stop`)).toHaveLength(1);
        expect(settleHostedStretch).toHaveBeenCalledTimes(1);
        expect(rollbackHosted).toHaveBeenCalledWith(
            config,
            { sandboxId: `s1`, connectToken: `connect-token`, ownerEmail: `owner@test.dev`, region: `iad`, tier: `free` },
            machine,
            logger,
            { prisma, hostedMachineId: `h1`, sandboxId: `s1` },
            { probation: false, busy: `refuse` },
        );
        expect(openHostedStretch).toHaveBeenCalledWith(prisma, { id: `h1`, sandboxId: `s1`, ownerId: `u1` });
        expect(warned).toHaveBeenCalledWith(expect.objectContaining({ app: `intentic-sbx-a`, previousImage: OLD }), expect.stringContaining(`earlier one was put back`));
    });

    it(`goes back at once on a journal that failed, and on a daemon netd cannot keep alive`, async () => {
        for (const answers of [JOURNAL_FAILED, LOOPING]) {
            seeded(`started`, 60, answers);
            const { prisma } = prismaOf();
            // one machine at a time
            const outcome = await watchHostedMachine(prisma, config, logger, candidate(60), NOW);
            expect(outcome.kind).toBe(`rolled-back`);
            unstubAllGlobals();
        }
        expect(rollbackHosted).toHaveBeenCalledTimes(2);
    });

    it(`says netd's crash loop in the words ic says it`, async () => {
        seeded(`started`, 60, LOOPING);
        const { prisma } = prismaOf();
        expect(await watchHostedMachine(prisma, config, logger, candidate(60), NOW)).toEqual({
            kind: `rolled-back`,
            reason: `the new version's daemon kept crashing: netd restarted it 3 times in the last ten minutes, and it is down again`,
        });
    });

    it(`ends the probation, keeping the new image, once the window is over and the image is well`, async () => {
        seeded(`started`, 60, HEALTHY);
        const { prisma, table } = prismaOf();
        const outcome = await watchHostedMachine(prisma, config, logger, candidate(UPDATE_PROBATION.watchMs / MINUTE_MS), NOW);
        expect(outcome).toEqual({ kind: `kept` });
        expect(table.update).toHaveBeenCalledWith({ where: { id: `h1` }, data: PROBATION_ENDS });
    });
});

describe(`what the watch leaves alone`, () => {
    it(`a machine that is asleep: nothing to judge until it runs, however long it has been down`, async () => {
        const fly = seeded(`stopped`, 600, SILENT);
        const { prisma, table } = prismaOf();
        expect(await watchHostedMachine(prisma, config, logger, candidate(300, { probationStrikes: 1 }), NOW)).toEqual({ kind: `watching`, strikes: 1 });
        expect(table.update).not.toHaveBeenCalled();
        expect(fly.called(`POST`, `/exec`)).toEqual([]);
    });

    it(`a machine still booting after a wake, however silent its daemon is`, async () => {
        const fly = seeded(`started`, 1, SILENT);
        const { prisma, table } = prismaOf();
        expect(await watchHostedMachine(prisma, config, logger, candidate(300), NOW)).toEqual({ kind: `skipped`, why: `the machine started less than 3 minutes ago` });
        expect(fly.called(`POST`, `/exec`)).toEqual([]);
        expect(table.update).not.toHaveBeenCalled();
    });

    it(`a machine Fly will not describe`, async () => {
        installFakeFly((name, value) => stubGlobal(name, value), { faults: { status: 500 } });
        const { prisma } = prismaOf();
        expect(await watchHostedMachine(prisma, config, logger, candidate(300), NOW)).toEqual({ kind: `skipped`, why: `Fly would not describe the machine` });
    });

    it(`a machine another change holds`, async () => {
        seeded(`started`, 60, SILENT);
        const { prisma } = prismaOf();
        const held = Promise.withResolvers<void>();
        const other = fakeHostedAppLock(config, `intentic-sbx-a`, true, async () => held.promise);
        expect(await watchHostedMachine(prisma, config, logger, candidate(300), NOW)).toEqual({ kind: `skipped`, why: `another change holds the machine` });
        held.resolve();
        await other;
    });

    it(`an image on trial, which its next start judges`, async () => {
        const fly = seeded(`started`, 60, SILENT);
        const { prisma } = prismaOf();
        expect(await watchHostedMachine(prisma, config, logger, candidate(300, { unprovenImage: NEW }), NOW)).toMatchObject({ kind: `skipped` });
        expect(fly.called(`POST`, `/exec`)).toEqual([]);
    });

    it(`a probation with nothing kept to go back to, which it ends`, async () => {
        const fly = seeded(`started`, 60, SILENT);
        const { prisma, table } = prismaOf();
        expect(await watchHostedMachine(prisma, config, logger, candidate(300, { previousImage: null }), NOW)).toEqual({ kind: `ended`, why: `no earlier image is kept` });
        expect(table.update).toHaveBeenCalledWith({ where: { id: `h1` }, data: PROBATION_ENDS });
        expect(fly.called(`POST`, `/exec`)).toEqual([]);
    });

    it(`a row that changed between the look and the decision: no stop, no rollback`, async () => {
        const fly = seeded(`started`, 60, JOURNAL_FAILED);
        const { prisma, table } = prismaOf();
        table.findUnique.mockResolvedValue({ probationSince: new Date(NOW - 5 * MINUTE_MS), previousImage: OLD, unprovenImage: null });
        expect(await watchHostedMachine(prisma, config, logger, candidate(60), NOW)).toEqual({ kind: `skipped`, why: `the row changed under the look` });
        expect(fly.called(`POST`, `/machines/m1/stop`)).toEqual([]);
        expect(rollbackHosted).not.toHaveBeenCalled();
    });

    it(`an owner whose hours are spent: starting the earlier image would spend what is gone`, async () => {
        const fly = seeded(`started`, 60, JOURNAL_FAILED);
        hostedBudgetOf.mockResolvedValueOnce({ metered: true, remainingMinutes: 0 });
        const { prisma } = prismaOf();
        expect(await watchHostedMachine(prisma, config, logger, candidate(60), NOW)).toEqual({ kind: `skipped`, why: `its owner's hours are spent` });
        expect(fly.called(`POST`, `/machines/m1/stop`)).toEqual([]);
    });
});

describe(`a go-back that does not go`, () => {
    it(`is not asked again in two minutes: the probation ends and the failure is said at warn for the gate's own kept version`, async () => {
        seeded(`started`, 60, JOURNAL_FAILED);
        rollbackHosted.mockRejectedValueOnce(new HostedImageKept(`the earlier version did not come up`, `rolled-back`, true));
        const { prisma, table } = prismaOf();
        expect(await watchHostedMachine(prisma, config, logger, candidate(60), NOW)).toEqual({ kind: `ended`, why: `going back failed` });
        expect(table.update).toHaveBeenCalledWith({ where: { id: `h1` }, data: PROBATION_ENDS });
        expect(warned).toHaveBeenCalledTimes(1);
        expect(errored).not.toHaveBeenCalled();
        expect(openHostedStretch).not.toHaveBeenCalled();
    });

    it(`ends the probation too for nothing to go back to, and says an unforeseen failure at error`, async () => {
        seeded(`started`, 60, JOURNAL_FAILED);
        rollbackHosted.mockRejectedValueOnce(new HostedNothingKept(`none`));
        const { prisma } = prismaOf();
        await watchHostedMachine(prisma, config, logger, candidate(60), NOW);
        expect(errored).not.toHaveBeenCalled();

        // The first go-back stopped the machine, as a real one does.
        seeded(`started`, 60, JOURNAL_FAILED);
        rollbackHosted.mockRejectedValueOnce(new Error(`Fly fell over`));
        await watchHostedMachine(prisma, config, logger, candidate(60), NOW);
        expect(errored).toHaveBeenCalledTimes(1);
    });

    it(`is looked at again when a change held the machine at the gate's own lock`, async () => {
        seeded(`started`, 60, JOURNAL_FAILED);
        rollbackHosted.mockRejectedValueOnce(new HostedMachineBusy(`busy`));
        const { prisma, table } = prismaOf();
        expect(await watchHostedMachine(prisma, config, logger, candidate(60), NOW)).toEqual({ kind: `skipped`, why: `another change holds the machine` });
        expect(table.update).not.toHaveBeenCalled();
    });
});

describe(`the sweep`, () => {
    it(`looks at the machines the gate put on probation, one at a time, and counts what it did`, async () => {
        seeded(`started`, 60, JOURNAL_FAILED);
        const { prisma, table } = prismaOf();
        expect(await sweepHostedProbation(prisma, config, logger, NOW)).toEqual({ looked: 1, rolledBack: 1, kept: 0 });
        expect(table.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { probationSince: { not: null } } }));
    });

    it(`survives a machine it cannot look at, and looks again next tick`, async () => {
        installFakeFly((name, value) => stubGlobal(name, value), { faults: { status: 500 } });
        const { prisma } = prismaOf();
        expect(await sweepHostedProbation(prisma, config, logger, NOW)).toEqual({ looked: 1, rolledBack: 0, kept: 0 });
    });
});
