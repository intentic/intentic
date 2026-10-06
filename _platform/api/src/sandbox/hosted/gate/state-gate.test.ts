import { stubGlobal, unstubAllGlobals } from "@intentic/testing/bun";
import { CLEAR_STATE_PLAN, type FakeFly, type FakeFlyCall, type FakeFlyExecAnswer, type FakeFlyMachine, installFakeFly } from "@intentic/testing/fly-fake";
import type { FlyMachineConfig } from "@intentic/sandbox-run/fly";
import type { Config } from "../../../config.js";
import { fakeGateRecord, fakeHostedAppLock, healthAnswer, machineAnswers, NO_HEALTH } from "../../../testing.js";
import { DAEMON_HEALTH_COMMAND, HEALTH_POLL_MS, JOURNAL_BUDGET_MS, READY_BUDGET_MS } from "./daemon-health.js";
import {
    HostedImageKept,
    HostedMachineBusy,
    pinnedImage,
    probeConfig,
    readPlanAnswer,
    ROLLBACK_WORDS,
    runningImageOf,
    startOnTrial,
    STATE_PLANNER,
    STATE_PROBE_ENV,
    switchHostedImage,
} from "./state-gate.js";
import * as timersPromisesOriginal from "node:timers/promises";

// The gate holds the app's lock throughout; the in-process one stands in for Postgres's.
jest.mock(`../hosted-app-lock.js`, () => ({ withHostedAppLock: fakeHostedAppLock }));

/* The settles around a probe and a start are half a second of real time each in production, polled many times. */
jest.mock("node:timers/promises", () => ({
    ...timersPromisesOriginal,
    setTimeout: async () => undefined,
}));

// SAFETY: the gate reads only the Fly token off the config.
const config = { hosted: { flyApiToken: `fly` } } as Config;
// What the gate said, and at which level.
const warned = jest.fn();
const errored = jest.fn();
// SAFETY: the gate calls only these three methods of its logger.
const logger = { info: jest.fn(), warn: warned, error: errored } as never;
const MACHINE = { appName: `intentic-sbx-a`, machineId: `m1` };

// What the machine was provisioned on, and the release it is being moved to.
const OLD = `ghcr.io/intentic/sandbox@sha256:${`a`.repeat(64)}`;
const NEW = `ghcr.io/intentic/sandbox@sha256:${`b`.repeat(64)}`;

// The config the machine holds now, with fields this platform never writes (Fly's own), which a rollback must keep.
const OLD_CONFIG = { image: OLD, env: { CONNECT_TOKEN: `t0k3n` }, mounts: [{ volume: `vol_1`, path: `/data` }], dns: { skip_registration: true } };
const target = (image = NEW): FlyMachineConfig => ({
    image,
    guest: { cpu_kind: `shared`, cpus: 2, memory_mb: 4096 },
    env: { CONNECT_TOKEN: `t0k3n`, SANDBOX_GRANT: `fresh` },
    mounts: [{ volume: `vol_1`, path: `/data` }],
    restart: { policy: `on-failure`, max_retries: 3 },
    auto_destroy: false,
});

// A registry beside Fly: `digest` is what it says a tag names, undefined a registry that cannot be reached.
const registry =
    (digest: string | undefined) =>
    (input: RequestInfo | URL): Promise<Response> =>
        digest === undefined
            ? Promise.reject(new Error(`registry unreachable: ${String(input)}`))
            : Promise.resolve(new Response(null, { status: 200, headers: { "docker-content-digest": digest } }));

const seeded = (state: `started` | `stopped`, digest?: string): FakeFly => {
    const fly = installFakeFly((name, value) => stubGlobal(name, value), { passThrough: registry(digest) });
    fly.apps.add(MACHINE.appName);
    const at = new Date().toISOString();
    fly.machines.set(`m1`, { id: `m1`, app: MACHINE.appName, region: `iad`, state, config: structuredClone(OLD_CONFIG), createdAt: at, updatedAt: at });
    return fly;
};
const configOf = (fly: FakeFly): object | undefined => fly.machines.get(`m1`)?.config;
const machineOf = (fly: FakeFly): FakeFlyMachine => {
    const machine = fly.machines.get(`m1`);
    if (machine === undefined) {
        throw new Error(`the fake holds no machine m1`);
    }
    return machine;
};
const stateOf = (fly: FakeFly): string | undefined => fly.machines.get(`m1`)?.state;
const planLine = (plan: Partial<typeof CLEAR_STATE_PLAN> | Record<string, boolean | object[]>): FakeFlyExecAnswer => ({
    exit_code: 0,
    stdout: `${JSON.stringify({ ...CLEAR_STATE_PLAN, ...plan })}\n`,
    stderr: ``,
});
const REFUSED = planLine({ ok: false, failures: [{ document: `notes/theme.json`, detail: `theme: not a colour` }] });

afterEach(() => {
    unstubAllGlobals();
    jest.clearAllMocks();
});

describe(`reading the planner's answer`, () => {
    it(`reads a clear plan, and a refusal with the failures it names`, () => {
        expect(readPlanAnswer({ exitCode: 0, stdout: `npm notice\n${JSON.stringify(CLEAR_STATE_PLAN)}\n`, stderr: `` })).toEqual({ kind: `clear`, version: `9.9.9` });
        expect(readPlanAnswer({ exitCode: 0, stdout: REFUSED.stdout, stderr: `` })).toEqual({
            kind: `refused`,
            version: `9.9.9`,
            failures: [{ document: `notes/theme.json`, detail: `theme: not a colour` }],
        });
    });

    // No plan to be had is not the planner's fault: an image from before it, or a plan newer than this platform reads.
    it.each([
        [`an image from before the engine`, { exitCode: 1, stdout: ``, stderr: `Error: Cannot find module '${STATE_PLANNER}'` }, `the image predates the state-conversion engine`],
        [
            `a format this does not read`,
            { exitCode: 0, stdout: JSON.stringify({ ...CLEAR_STATE_PLAN, plan: 2 }), stderr: `` },
            `the planner answered plan format 2, which this platform does not read`,
        ],
    ])(`reads %s as no plan`, (_, answer, reason) => {
        expect(readPlanAnswer(answer)).toEqual({ kind: `unknown`, reason });
    });

    // A planner that ran and could not say the conversions would work has not said they would: broken, which refuses.
    it.each([
        [`a planner that threw`, { exitCode: 1, stdout: ``, stderr: `    at x\nTypeError: boom\n` }, `the planner exited with status 1: TypeError: boom`],
        [`an empty answer`, { exitCode: 0, stdout: `\n`, stderr: `` }, `the planner answered nothing`],
        [`an answer that is not JSON`, { exitCode: 0, stdout: `hello`, stderr: `` }, `the planner's answer is not a plan: hello`],
        [`a plan that names no format`, { exitCode: 0, stdout: JSON.stringify({ ok: true }), stderr: `` }, `the planner's answer names no plan format`],
        [`a plan that does not say`, { exitCode: 0, stdout: JSON.stringify({ plan: 1 }), stderr: `` }, `the planner's plan does not say whether it would succeed`],
        [`a plan whose ok is not a boolean`, { exitCode: 0, stdout: JSON.stringify({ plan: 1, ok: `false` }), stderr: `` }, `the planner's plan does not say whether it would succeed`],
        [
            `a module of its own the planner imports and the image lacks`,
            {
                exitCode: 1,
                stdout: ``,
                stderr: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/opt/sandbox/dist/store/newest-run.js' imported from ${STATE_PLANNER}\n`,
            },
            `the planner exited with status 1: Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/opt/sandbox/dist/store/newest-run.js' imported from ${STATE_PLANNER}`,
        ],
        [
            `a package the daemon imports and the image never installed`,
            {
                exitCode: 1,
                stdout: ``,
                stderr: `Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'ssh2' imported from /opt/sandbox/dist/capabilities/credentials/ssh-keys.js\n`,
            },
            `the planner exited with status 1: Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'ssh2' imported from /opt/sandbox/dist/capabilities/credentials/ssh-keys.js`,
        ],
    ])(`reads %s as a broken planner`, (_, answer, reason) => {
        expect(readPlanAnswer(answer)).toEqual({ kind: `broken`, reason });
    });
});

describe(`the image a machine runs`, () => {
    it(`pins a tag to the digest it resolved to, and leaves a digest or an unresolved tag as it is`, () => {
        expect(pinnedImage(`ghcr.io/intentic/sandbox:stable`, `sha256:abc`)).toBe(`ghcr.io/intentic/sandbox@sha256:abc`);
        expect(pinnedImage(`registry:5000/sandbox`, `sha256:abc`)).toBe(`registry:5000/sandbox@sha256:abc`);
        expect(pinnedImage(OLD, `sha256:other`)).toBe(OLD);
        expect(pinnedImage(`ghcr.io/intentic/sandbox:stable`, undefined)).toBe(`ghcr.io/intentic/sandbox:stable`);
    });

    it(`reads it off Fly, or off the marker a dead gate's probe left`, async () => {
        const fly = seeded(`stopped`);
        await expect(runningImageOf(config, MACHINE)).resolves.toBe(OLD);
        machineOf(fly).config = { image: NEW, env: { [STATE_PROBE_ENV]: OLD } };
        await expect(runningImageOf(config, MACHINE)).resolves.toBe(OLD);
    });

    // The probe boots nothing: no daemon, no restart, and the marker names what to go back to. Fly mounts
    // the volume read-write with a network, so the platform's credentials stay out of it: the marker is all it carries.
    it(`probes with the target image and volume, the daemon's entrypoint replaced, and no credentials`, () => {
        const probe = probeConfig(target(), OLD);
        expect(probe).toMatchObject({ image: NEW, mounts: [{ volume: `vol_1`, path: `/data` }], restart: { policy: `no` } });
        expect(probe.init?.entrypoint?.slice(0, 2)).toEqual([`/bin/sh`, `-c`]);
        expect(probe.env).toEqual({ [STATE_PROBE_ENV]: OLD });
        expect(probe).not.toHaveProperty(`services`);
        expect(probe).not.toHaveProperty(`checks`);
    });
});

describe(`switching a machine's image under the state gate`, () => {
    it(`asks the target's planner over the volume, then applies the target and starts it`, async () => {
        const fly = seeded(`stopped`);
        await switchHostedImage(config, MACHINE, target(), { start: true, logger });
        const [exec] = fly.called(`POST`, `/machines/m1/exec`);
        expect(exec?.body).toEqual({
            command: [`/usr/local/bin/node`, STATE_PLANNER, `--workspace`, `/data/work`, `--history`, `/data/history`],
            timeout: 60,
        });
        // Probe first, then the real config: the planner ran before the new daemon could touch anything.
        expect(fly.called(`POST`, `/machines/m1`)).toHaveLength(2);
        const lastUpdate = fly.calls.findLastIndex((call) => call.method === `POST` && call.path.endsWith(`/machines/m1`));
        expect(fly.indexOf(`POST`, `/machines/m1/exec`)).toBeLessThan(lastUpdate);
        expect(configOf(fly)).toEqual(target());
        expect(stateOf(fly)).toBe(`started`);
    });

    it(`leaves a stopped machine stopped when no start is asked for`, async () => {
        const fly = seeded(`stopped`);
        await switchHostedImage(config, MACHINE, target(), { start: false, logger });
        expect(configOf(fly)).toEqual(target());
        expect(stateOf(fly)).toBe(`stopped`);
    });

    it(`converts nothing on the digest the machine already runs, so it asks nothing`, async () => {
        const fly = seeded(`started`);
        await switchHostedImage(config, MACHINE, target(OLD), { start: true, logger });
        expect(fly.called(`POST`, `/machines/m1/exec`)).toEqual([]);
        expect(fly.called(`POST`, `/machines/m1`)).toHaveLength(1);
        expect(configOf(fly)).toEqual(target(OLD));
    });

    it(`refuses a target that cannot convert this sandbox's state, and puts the machine back as it was`, async () => {
        const fly = seeded(`started`);
        fly.commands.answer = () => REFUSED;
        const kept = await switchHostedImage(config, MACHINE, target(), { start: true, logger }).catch((error: unknown) => error);
        expect(kept).toBeInstanceOf(HostedImageKept);
        expect(kept).toMatchObject({
            reason: `refused`,
            running: true,
            message: `intentic 9.9.9 cannot convert this sandbox's stored state, so the update was stopped before it began and the sandbox stays on the version it had (notes/theme.json: theme: not a colour)`,
        });
        // Fly's own fields survive the round trip: this is the config the machine had, not a recomposition of it.
        expect(configOf(fly)).toEqual(OLD_CONFIG);
        expect(stateOf(fly)).toBe(`started`);
    });

    it(`keeps the image but takes the new config when a refusal asks to`, async () => {
        const fly = seeded(`started`);
        fly.commands.answer = () => REFUSED;
        await expect(switchHostedImage(config, MACHINE, target(), { start: true, keepImage: true, logger })).rejects.toBeInstanceOf(HostedImageKept);
        expect(configOf(fly)).toEqual({ ...target(), image: OLD });
    });

    // THE FAIL-SAFE: no plan is the update as it ran before the gate, never a machine left without one.
    it.each([
        [`an image from before the engine`, () => ({ exit_code: 1, stdout: ``, stderr: `Error: Cannot find module '${STATE_PLANNER}'` })],
        [`a plan in a format newer than this platform reads`, () => planLine({ plan: 2 })],
    ])(`switches as before the gate on %s`, async (_, answer) => {
        const fly = seeded(`stopped`);
        fly.commands.answer = machineAnswers({ plan: answer });
        await switchHostedImage(config, MACHINE, target(), { start: true, logger });
        expect(configOf(fly)).toEqual(target());
        expect(stateOf(fly)).toBe(`started`);
    });

    it(`switches as before the gate when the probe itself cannot be asked`, async () => {
        const fly = seeded(`stopped`);
        fly.commands.answer = machineAnswers({
            plan: () => {
                throw new Error(`exec is down`);
            },
        });
        await switchHostedImage(config, MACHINE, target(), { start: true, logger });
        expect(configOf(fly)).toEqual(target());
    });

    /* A PLANNER THAT RAN AND BROKE REFUSES. It crashed, or answered what is not a plan: nothing has said the conversions
     * would work, and an image whose planner is broken is not one to boot over this sandbox's files. */
    it.each([
        [
            `crashed`,
            () => ({ exit_code: 1, stdout: ``, stderr: `TypeError: boom\n` }),
            `the new version could not check this sandbox's stored state (the planner exited with status 1: TypeError: boom), so the update was stopped before it began and the sandbox stays on the version it had`,
        ],
        [
            `answered what is not a plan`,
            () => ({ exit_code: 0, stdout: `garbage`, stderr: `` }),
            `the new version could not check this sandbox's stored state (the planner's answer is not a plan: garbage), so the update was stopped before it began and the sandbox stays on the version it had`,
        ],
    ])(`keeps the machine's version when the planner %s, and says so`, async (_, answer, message) => {
        const fly = seeded(`started`);
        fly.commands.answer = machineAnswers({ plan: answer });
        const kept = await switchHostedImage(config, MACHINE, target(), { start: true, logger }).catch((error: unknown) => error);
        expect(kept).toBeInstanceOf(HostedImageKept);
        expect(kept).toMatchObject({ reason: `refused`, running: true, message });
        expect(configOf(fly)).toEqual(OLD_CONFIG);
        expect(stateOf(fly)).toBe(`started`);
    });

    /* A NEW VERSION THAT WILL NOT BOOT IS PUT BACK. Its probe cannot start either (no plan, so the switch goes ahead as
     * it always did), the real start fails, and the machine goes back to the digest it ran, running. */
    it(`puts the previous version back and starts it when the new one does not start`, async () => {
        const fly = seeded(`started`);
        fly.fail({ imageWontStart: NEW });
        const kept = await switchHostedImage(config, MACHINE, target(), { start: true, logger }).catch((error: unknown) => error);
        expect(kept).toBeInstanceOf(HostedImageKept);
        expect(kept).toMatchObject({
            reason: `rolled-back`,
            running: true,
            message: expect.stringMatching(/^the new version did not start, so the sandbox was put back on the version it had: fly machine m1 did not start/u),
        });
        expect(configOf(fly)).toEqual(OLD_CONFIG);
        expect(stateOf(fly)).toBe(`started`);
    });

    // A probe a dead gate left is never the config to go back to: its marker names the image, the target the rest.
    it(`goes back to the image a dead gate's probe marker names`, async () => {
        const fly = seeded(`stopped`);
        machineOf(fly).config = { ...probeConfig(target(), OLD) };
        fly.commands.answer = () => REFUSED;
        await expect(switchHostedImage(config, MACHINE, target(), { start: true, logger })).rejects.toBeInstanceOf(HostedImageKept);
        expect(configOf(fly)).toEqual({ ...target(), image: OLD });
        expect(stateOf(fly)).toBe(`started`);
    });
});

/* ONE CHANGE AT A TIME. A second gate on the same machine would replace the first one's probe under its exec, whose
 * failure reads as "no plan" and goes ahead: the first gate's refusal would be lost. */
describe(`two changes to one machine`, () => {
    it(`refuses a second change that will not wait while the first is mid-probe, and the first's refusal stands`, async () => {
        const fly = seeded(`started`);
        let second: Promise<unknown> | undefined;
        fly.commands.answer = () => {
            second ??= switchHostedImage(config, MACHINE, target(), { start: true, busy: `refuse`, logger }).catch((error: unknown) => error);
            return REFUSED;
        };
        await expect(switchHostedImage(config, MACHINE, target(), { start: true, logger })).rejects.toMatchObject({ reason: `refused` });
        expect(await second).toBeInstanceOf(HostedMachineBusy);
        expect(fly.called(`POST`, `/machines/m1/exec`)).toHaveLength(1);
        expect(configOf(fly)).toEqual(OLD_CONFIG);
        expect(stateOf(fly)).toBe(`started`);
    });

    it(`runs a second change that waits after the first, never inside it`, async () => {
        const fly = seeded(`started`);
        let second: Promise<unknown> | undefined;
        const execs: number[] = [];
        fly.commands.answer = () => {
            execs.push(fly.calls.length);
            second ??= switchHostedImage(config, MACHINE, target(), { start: true, logger }).catch((error: unknown) => error);
            return REFUSED;
        };
        await expect(switchHostedImage(config, MACHINE, target(), { start: true, logger })).rejects.toBeInstanceOf(HostedImageKept);
        expect(await second).toBeInstanceOf(HostedImageKept);
        // The second probe was written only after the first gate had put the machine back.
        expect(execs).toHaveLength(2);
        const firstRestore = fly.calls.findIndex((call, index) => index > (execs[0] ?? 0) && call.method === `POST` && call.path.endsWith(`/machines/m1`));
        const secondProbe = fly.calls.findIndex((call, index) => index > firstRestore && call.method === `POST` && call.path.endsWith(`/machines/m1`));
        expect(firstRestore).toBeGreaterThan(-1);
        expect(secondProbe).toBeGreaterThan(firstRestore);
        expect(execs[1]).toBeGreaterThan(secondProbe);
    });
});

describe(`the probe's own start`, () => {
    /* `starting` is not `started`: Fly refuses an exec in a machine that is still coming up, and that refusal would
     * read as "no plan", which goes ahead. The gate waits, so a slow probe's refusal still refuses. */
    it(`waits for a probe that is still starting before asking it, so its refusal is heard`, async () => {
        const fly = seeded(`started`);
        fly.fail({ startingReads: 3 });
        fly.commands.answer = () => REFUSED;
        await expect(switchHostedImage(config, MACHINE, target(), { start: true, logger })).rejects.toMatchObject({ reason: `refused` });
        expect(fly.called(`POST`, `/machines/m1/exec`)).toHaveLength(1);
        expect(configOf(fly)).toEqual(OLD_CONFIG);
    });

    /* A probe that never comes up has nothing to say: no plan, the fail-safe, never a refusal, so the switch goes ahead.
     * Here the machine never reads started for the new version either, so its daemon never answers, and that is what
     * puts it back: the fail-safe no longer ends at Fly's word that a start was accepted. */
    it(`counts a probe that never reads started as no plan and switches, and the daemon's silence puts it back`, async () => {
        const fly = seeded(`stopped`);
        fly.fail({ startingReads: Number.POSITIVE_INFINITY });
        fly.commands.answer = () => REFUSED;
        const kept = await switchHostedImage(config, MACHINE, target(), { start: true, logger }).catch((error: unknown) => error);
        expect(fly.called(`POST`, `/machines/m1/exec`)).toEqual([]);
        expect(warned).toHaveBeenCalledWith(
            expect.objectContaining({ reason: expect.stringMatching(/^the probe never came up/u) }),
            expect.stringContaining(`no state plan`),
        );
        expect(kept).toMatchObject({
            reason: `rolled-back`,
            message: `the new version did not come up, so the sandbox was put back on the version it had: its daemon did not answer within 3 minutes of starting`,
        });
        expect(configOf(fly)).toEqual(OLD_CONFIG);
    });
});

describe(`a target named by a tag`, () => {
    const TAG = `ghcr.io/intentic/sandbox:stable`;
    // The first config written is the probe's.
    const probeOf = (fly: FakeFly): FakeFlyCall | undefined => fly.called(`POST`, `/machines/m1`)[0];

    it(`is pinned to the registry's digest before the probe, so the probe and the switch run one image`, async () => {
        const digest = `sha256:${`c`.repeat(64)}`;
        const fly = seeded(`stopped`, digest);
        await switchHostedImage(config, MACHINE, target(TAG), { start: true, logger });
        expect(probeOf(fly)?.body).toMatchObject({ config: { image: `ghcr.io/intentic/sandbox@${digest}` } });
        expect(configOf(fly)).toMatchObject({ image: `ghcr.io/intentic/sandbox@${digest}` });
    });

    // A registry that will not answer: Fly resolved the tag for the probe, and that digest is what the switch applies.
    it(`is pinned to the digest the probe ran when the registry cannot say`, async () => {
        const fly = seeded(`stopped`);
        await switchHostedImage(config, MACHINE, target(TAG), { start: true, logger });
        expect(probeOf(fly)?.body).toMatchObject({ config: { image: TAG } });
        expect(configOf(fly)).toMatchObject({ image: `ghcr.io/intentic/sandbox@sha256:m1` });
    });
});

/* A ROLLBACK THAT FAILS IS LOUD: an error line naming the machine and both images, and the row stamped so hosted health
 * reports it. */
describe(`a rollback that fails`, () => {
    it(`logs the machine and both versions at error, and records it on the machine's row`, async () => {
        const fly = seeded(`started`);
        fly.fail({ machineWontStart: true });
        const { record, prisma } = fakeGateRecord();
        const kept = await switchHostedImage(config, MACHINE, target(), { start: true, logger, record }).catch((error: unknown) => error);
        expect(kept).toMatchObject({ reason: `rolled-back`, running: false });
        expect(errored).toHaveBeenCalledWith(
            expect.objectContaining({ app: MACHINE.appName, machineId: `m1`, previousImage: OLD, targetImage: NEW }),
            expect.stringContaining(`putting the previous version back failed`),
        );
        expect(prisma.hostedMachine.update).toHaveBeenCalledWith({
            where: { id: `h1` },
            data: { strandedAt: expect.any(Date), strandedDetail: expect.stringContaining(`moving ${OLD} to ${NEW}`) },
        });
        // Stranded, not moved: the row keeps no way back to a version the machine is not on either.
        expect(prisma.hostedMachine.update).toHaveBeenCalledTimes(1);
        expect(fly.machines.size).toBe(1);
    });
});

/* THE NEW VERSION IS JUDGED BY ITS DAEMON, not by Fly's word that the machine started: its /health, asked inside the
 * machine, has to read ready with the state journal committed. */
describe(`waiting for the new version's daemon`, () => {
    // Fly's own machine object, for a health answer that plays something happening to it.
    // The health route itself: netd's vitals are asked with the same curl.
    const healthAsks = (fly: FakeFly): number =>
        fly.called(`POST`, `/machines/m1/exec`).filter((call) => JSON.stringify(call.body).includes(DAEMON_HEALTH_COMMAND.at(-1) ?? ``)).length;

    it(`keeps the new version once its daemon reads ready with its journal committed, waiting through the conversion`, async () => {
        const fly = seeded(`stopped`);
        const answers = [
            healthAnswer({ boot: { ready: false }, state: { journal: `none` } }),
            healthAnswer({ boot: { ready: true }, state: { journal: `open` } }),
            healthAnswer({ boot: { ready: true }, state: { journal: `none` } }),
        ];
        fly.commands.answer = machineAnswers({ health: (asked) => answers[asked] ?? NO_HEALTH });
        await switchHostedImage(config, MACHINE, target(), { start: true, logger });
        expect(healthAsks(fly)).toBe(3);
        expect(configOf(fly)).toEqual(target());
        expect(stateOf(fly)).toBe(`started`);
        // The planner, then the daemon: the health ask comes after the start of the real config.
        const lastStart = fly.calls.findLastIndex((call) => call.method === `POST` && call.path.endsWith(`/machines/m1/start`));
        expect(fly.calls.findIndex((call, index) => index > lastStart && call.path.endsWith(`/exec`))).toBeGreaterThan(lastStart);
    });

    it.each([
        [
            `reports its journal failed`,
            () => healthAnswer({ boot: { ready: true }, state: { journal: `failed` } }),
            `it could not convert this sandbox's stored files, and put them back as they were`,
        ],
        [`never answers`, () => NO_HEALTH, `its daemon did not answer within 3 minutes of starting`],
        [
            `never commits its journal`,
            () => healthAnswer({ boot: { ready: false }, state: { journal: `open` } }),
            `it was still converting this sandbox's stored files after 10 minutes`,
        ],
    ])(`puts the previous version back, running, when the new daemon %s`, async (_, health, reason) => {
        const fly = seeded(`started`);
        fly.commands.answer = machineAnswers({ health });
        const kept = await switchHostedImage(config, MACHINE, target(), { start: true, logger }).catch((error: unknown) => error);
        expect(kept).toBeInstanceOf(HostedImageKept);
        expect(kept).toMatchObject({
            reason: `rolled-back`,
            running: true,
            message: `the new version did not come up, so the sandbox was put back on the version it had: ${reason}`,
        });
        expect(configOf(fly)).toEqual(OLD_CONFIG);
        expect(stateOf(fly)).toBe(`started`);
    });

    // The budget is a clock and a count of looks both; which one is what an open journal changes.
    it(`waits the journal's longer budget once the journal was seen open, and the ready budget otherwise`, async () => {
        const converting = seeded(`stopped`);
        converting.commands.answer = machineAnswers({ health: () => healthAnswer({ boot: { ready: false }, state: { journal: `open` } }) });
        await expect(switchHostedImage(config, MACHINE, target(), { start: true, logger })).rejects.toBeInstanceOf(HostedImageKept);
        expect(healthAsks(converting)).toBe(JOURNAL_BUDGET_MS / HEALTH_POLL_MS);
        unstubAllGlobals();
        const silent = seeded(`stopped`);
        silent.commands.answer = machineAnswers({ health: () => NO_HEALTH });
        await expect(switchHostedImage(config, MACHINE, target(), { start: true, logger })).rejects.toBeInstanceOf(HostedImageKept);
        expect(healthAsks(silent)).toBe(READY_BUDGET_MS / HEALTH_POLL_MS);
    });

    /* A CRASH LOOP IS A CRASH. Fly restarts a machine whose process exits (on-failure, three times), so the machine can
     * read started while its version keeps falling over: an exit after the start is the verdict. */
    it.each([
        [`exits`, { exitCode: 1 }, `it exited with status 1 as it started`],
        [`runs out of memory`, { exitCode: 137, oomKilled: true }, `it ran out of memory as it started`],
    ])(`puts the previous version back when the new version %s after starting, even while Fly restarts it`, async (_, exit, reason) => {
        const fly = seeded(`stopped`);
        fly.commands.answer = machineAnswers({
            health: (asked, machine) => {
                machine.exit = exit;
                return asked === 0 ? NO_HEALTH : healthAnswer({ boot: { ready: true } });
            },
        });
        await expect(switchHostedImage(config, MACHINE, target(), { start: true, logger })).rejects.toMatchObject({
            reason: `rolled-back`,
            message: `the new version did not come up, so the sandbox was put back on the version it had: ${reason}`,
        });
        expect(configOf(fly)).toEqual(OLD_CONFIG);
    });

    it(`puts the previous version back when the new version's machine stops with nothing to say why`, async () => {
        const fly = seeded(`stopped`);
        fly.commands.answer = machineAnswers({
            health: (_asked, machine) => {
                machine.state = `stopped`;
                return NO_HEALTH;
            },
        });
        await expect(switchHostedImage(config, MACHINE, target(), { start: true, logger })).rejects.toMatchObject({
            reason: `rolled-back`,
            message: `the new version did not come up, so the sandbox was put back on the version it had: its machine reads stopped before the new version was ready`,
        });
        expect(stateOf(fly)).toBe(`started`);
    });

    // The announce the new daemon makes as it boots is the platform's own proof it is reachable at all.
    it(`puts the previous version back when the sandbox never checks in with the platform`, async () => {
        const fly = seeded(`stopped`);
        fly.commands.answer = machineAnswers({});
        const { record } = fakeGateRecord({}, false);
        await expect(switchHostedImage(config, MACHINE, target(), { start: true, logger, record })).rejects.toMatchObject({
            reason: `rolled-back`,
            message: `the new version did not come up, so the sandbox was put back on the version it had: it did not check in with the platform within 3 minutes of starting`,
        });
        expect(configOf(fly)).toEqual(OLD_CONFIG);
    });
});

/* WHAT THE ROW KEEPS. A change that took leaves the version it replaced as the way back; one the gate could not judge is
 * on trial, and its next start is judged; a version put back is what the row names again. */
describe(`what the machine's row keeps`, () => {
    it(`keeps the version a change replaced as the way back, and clears the digest a rollback skipped`, async () => {
        const fly = seeded(`stopped`);
        fly.commands.answer = machineAnswers({});
        const { record, updates } = fakeGateRecord({ skippedDigest: `sha256:${`e`.repeat(64)}` });
        await switchHostedImage(config, MACHINE, target(), { start: true, logger, record });
        expect(updates).toEqual([{ previousImage: OLD, previousEnvironmentHash: null, unprovenImage: null, skippedDigest: null }]);
    });

    it(`writes the target's overlay facts beside the image, and keeps the recipe the replaced overlay carried`, async () => {
        const overlay = `registry.fly.io/intentic-sbx-a@sha256:${`c`.repeat(64)}`;
        const fly = seeded(`stopped`);
        machineOf(fly).config = { ...OLD_CONFIG, image: overlay };
        fly.commands.answer = machineAnswers({});
        const { record, row } = fakeGateRecord({ image: overlay, environmentHash: `h-old`, baseImage: `ghcr.io/intentic/sandbox:stable` });
        await switchHostedImage(config, MACHINE, target(), {
            start: true,
            logger,
            record,
            facts: { environmentHash: `h-new`, baseImage: `ghcr.io/intentic/sandbox:stable`, baseDigest: `sha256:${`d`.repeat(64)}` },
        });
        expect(row).toMatchObject({
            image: NEW,
            environmentHash: `h-new`,
            baseDigest: `sha256:${`d`.repeat(64)}`,
            previousImage: overlay,
            previousEnvironmentHash: `h-old`,
            unprovenImage: null,
        });
    });

    it(`puts a change applied to a stopped machine on trial`, async () => {
        const fly = seeded(`stopped`);
        const { record, updates } = fakeGateRecord();
        await switchHostedImage(config, MACHINE, target(), { start: false, logger, record });
        expect(updates).toEqual([{ previousImage: OLD, previousEnvironmentHash: null, unprovenImage: NEW, skippedDigest: null }]);
        expect(stateOf(fly)).toBe(`stopped`);
        // Nothing was started, so nothing was asked of a daemon.
        expect(fly.called(`POST`, `/machines/m1/exec`)).toHaveLength(1);
    });

    /* A STOP FROM OUTSIDE IS NOT A VERDICT. The daemon's own idle-stop, or an operator's stop, mid-wait: the version is
     * neither kept as proven nor rolled back and restarted, but left on trial for whatever starts it next. */
    it(`leaves the version on trial, stopped, when the machine is stopped while its daemon is waited for`, async () => {
        const fly = seeded(`stopped`);
        fly.commands.answer = machineAnswers({
            health: (_asked, machine) => {
                machine.state = `stopped`;
                machine.exit = { exitCode: 0 };
                return NO_HEALTH;
            },
        });
        const { record, row } = fakeGateRecord();
        await switchHostedImage(config, MACHINE, target(), { start: true, logger, record });
        expect(configOf(fly)).toEqual(target());
        expect(stateOf(fly)).toBe(`stopped`);
        expect(row).toMatchObject({ previousImage: OLD, unprovenImage: NEW });
        expect(warned).toHaveBeenCalledWith(expect.objectContaining({ image: NEW }), expect.stringContaining(`stays on trial`));
    });
});

/* AN IMAGE ON TRIAL IS JUDGED BY ITS NEXT START: the wake after a rebuild applied while the machine slept, or a restart
 * that keeps its digest. It goes back to the kept version when its daemon does not come up. */
describe(`an image on trial`, () => {
    const onTrial = (state: `started` | `stopped`) => {
        const fly = seeded(state);
        machineOf(fly).config = { ...target() };
        return fly;
    };

    it(`is kept once a start sees its daemon come up, and the way back stays the version before it`, async () => {
        const fly = onTrial(`stopped`);
        fly.commands.answer = machineAnswers({});
        const { record, updates } = fakeGateRecord({ unprovenImage: NEW, previousImage: OLD });
        await startOnTrial(config, MACHINE, { record, logger });
        expect(stateOf(fly)).toBe(`started`);
        expect(updates).toEqual([{ previousImage: OLD, previousEnvironmentHash: null, unprovenImage: null }]);
    });

    it(`goes back to the kept version, composed around this machine's config, when its daemon does not come up`, async () => {
        const fly = onTrial(`stopped`);
        fly.commands.answer = machineAnswers({ health: () => healthAnswer({ state: { journal: `failed` } }) });
        const { record, row } = fakeGateRecord({ image: NEW, environmentHash: `h-new`, unprovenImage: NEW, previousImage: OLD });
        const compose = (image: string, environmentHash: string | null): FlyMachineConfig => ({ ...target(image), env: { COMPOSED: environmentHash ?? `stock` } });
        const kept = await startOnTrial(config, MACHINE, { record, compose, logger }).catch((error: unknown) => error);
        expect(kept).toMatchObject({ reason: `rolled-back`, running: true });
        expect(configOf(fly)).toEqual(compose(OLD, null));
        expect(stateOf(fly)).toBe(`started`);
        // The row names the version it runs again, and keeps nothing before it.
        expect(row).toMatchObject({ image: null, environmentHash: null, previousImage: null, unprovenImage: null });
    });

    it(`is judged when a change keeps its digest, and put back like any other`, async () => {
        const fly = onTrial(`started`);
        fly.commands.answer = machineAnswers({ health: () => NO_HEALTH });
        const { record } = fakeGateRecord({ unprovenImage: NEW, previousImage: OLD });
        await expect(switchHostedImage(config, MACHINE, target(), { start: true, logger, record })).rejects.toMatchObject({ reason: `rolled-back` });
        // Its own digest converts nothing: no planner was asked.
        expect(fly.called(`POST`, `/machines/m1/exec`).filter((call) => JSON.stringify(call.body).includes(STATE_PLANNER))).toEqual([]);
        expect(machineOf(fly).config).toMatchObject({ image: OLD });
    });

    it(`is simply started once no longer on trial`, async () => {
        const fly = onTrial(`stopped`);
        const { record, updates } = fakeGateRecord({ previousImage: OLD });
        await startOnTrial(config, MACHINE, { record, logger });
        expect(stateOf(fly)).toBe(`started`);
        expect(fly.called(`POST`, `/machines/m1/exec`)).toEqual([]);
        expect(updates).toEqual([]);
    });

    it(`answers busy while another change holds the machine`, async () => {
        const fly = seeded(`started`);
        let trial: Promise<unknown> | undefined;
        fly.commands.answer = () => {
            trial ??= startOnTrial(config, MACHINE, { record: fakeGateRecord({ unprovenImage: NEW, previousImage: OLD }).record, logger }).catch(
                (error: unknown) => error,
            );
            return REFUSED;
        };
        await expect(switchHostedImage(config, MACHINE, target(), { start: true, logger })).rejects.toBeInstanceOf(HostedImageKept);
        expect(await trial).toBeInstanceOf(HostedMachineBusy);
    });
});

/* THE OWNER'S ROLLBACK is a change like any other, told in its own words, and pressing it twice goes forward again. */
describe(`going back`, () => {
    it(`names a refused rollback as a rollback`, async () => {
        seeded(`started`).commands.answer = () => REFUSED;
        await expect(switchHostedImage(config, MACHINE, target(), { start: true, logger, words: ROLLBACK_WORDS })).rejects.toMatchObject({
            reason: `refused`,
            message: expect.stringMatching(/^intentic 9\.9\.9 cannot convert this sandbox's stored state, so the rollback was stopped before it began/u),
        });
    });

    it(`keeps the version it left as the way back, and the digest to skip it was asked to`, async () => {
        const fly = seeded(`stopped`);
        machineOf(fly).config = { ...target() };
        fly.commands.answer = machineAnswers({});
        const { record, row } = fakeGateRecord({ previousImage: OLD });
        await switchHostedImage(config, MACHINE, { ...target(), image: OLD }, { start: true, logger, record, skip: `sha256:${`b`.repeat(64)}`, words: ROLLBACK_WORDS });
        expect(row).toMatchObject({ previousImage: NEW, skippedDigest: `sha256:${`b`.repeat(64)}`, unprovenImage: null });
    });

    // The image held was never seen healthy; going back to the one before it keeps the one on trial as the way forward.
    it(`keeps the image on trial as the way forward when going back to the version before it`, async () => {
        const fly = seeded(`stopped`);
        machineOf(fly).config = { ...target() };
        fly.commands.answer = machineAnswers({});
        const { record, row } = fakeGateRecord({ unprovenImage: NEW, previousImage: OLD });
        await switchHostedImage(config, MACHINE, { ...target(), image: OLD }, { start: true, logger, record, words: ROLLBACK_WORDS });
        expect(row).toMatchObject({ previousImage: NEW, unprovenImage: null });
    });

    // The version before an image on trial is both what the rollback moves to and the "last good" one: when it does not
    // come up, the machine goes back to the image it held, not onto the version that just failed (2026-10 bug hunt).
    it(`puts the image it held back when the version before an image on trial does not come up`, async () => {
        const fly = seeded(`stopped`);
        machineOf(fly).config = { ...target() };
        fly.commands.answer = machineAnswers({
            health: (_asked, machine) => (machine.config[`image`] === OLD ? NO_HEALTH : healthAnswer({ boot: { ready: true }, state: { journal: `none` } })),
        });
        const { record, row } = fakeGateRecord({ unprovenImage: NEW, previousImage: OLD });
        const kept = await switchHostedImage(config, MACHINE, { ...target(), image: OLD }, { start: true, logger, record, words: ROLLBACK_WORDS }).catch(
            (error: unknown) => error,
        );
        expect(kept).toBeInstanceOf(HostedImageKept);
        expect(kept).toMatchObject({ reason: `rolled-back`, running: true, message: expect.stringMatching(/^the earlier version did not come up, so the sandbox was put back on the version it had/u) });
        expect(machineOf(fly)).toMatchObject({ state: `started`, config: { image: NEW } });
        // Nothing was learned about either version: the way back and the trial stand as they were.
        expect(row).toMatchObject({ previousImage: OLD, unprovenImage: NEW });
    });
});
