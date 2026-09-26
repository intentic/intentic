import { stubGlobal, unstubAllGlobals } from "@intentic/testing/bun";
import { CLEAR_STATE_PLAN, type FakeFly, type FakeFlyExecAnswer, type FakeFlyMachine, installFakeFly } from "@intentic/testing/fly-fake";
import type { FlyMachineConfig } from "@intentic/sandbox-run/fly";
import type { Config } from "../../../config.js";
import {
    HostedImageKept,
    pinnedImage,
    probeConfig,
    readPlanAnswer,
    runningImageOf,
    STATE_PLANNER,
    STATE_PROBE_ENV,
    switchHostedImage,
} from "./state-gate.js";
import * as timersPromisesOriginal from "node:timers/promises";

/* The settles around a probe and a start are half a second of real time each in production, polled many times. */
jest.mock("node:timers/promises", () => ({
    ...timersPromisesOriginal,
    setTimeout: async () => undefined,
}));

// SAFETY: the gate reads only the Fly token off the config.
const config = { hosted: { flyApiToken: `fly` } } as Config;
// SAFETY: the gate calls only these three methods of its logger.
const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() } as never;
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
    services: [],
    checks: {},
});

const seeded = (state: `started` | `stopped`): FakeFly => {
    const fly = installFakeFly((name, value) => stubGlobal(name, value));
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

    // Only an explicit `ok: false` refuses: every other way to fail is "no plan", which the caller's fail-safe decides.
    it.each([
        [`an image from before the engine`, { exitCode: 1, stdout: ``, stderr: `Error: Cannot find module '${STATE_PLANNER}'` }, `the image predates the state-conversion engine`],
        [`a planner that threw`, { exitCode: 1, stdout: ``, stderr: `    at x\nTypeError: boom\n` }, `the planner exited with status 1: TypeError: boom`],
        [`an empty answer`, { exitCode: 0, stdout: `\n`, stderr: `` }, `the planner answered nothing`],
        [`an answer that is not JSON`, { exitCode: 0, stdout: `hello`, stderr: `` }, `the planner's answer is not a plan: hello`],
        [
            `a format this does not read`,
            { exitCode: 0, stdout: JSON.stringify({ ...CLEAR_STATE_PLAN, plan: 2 }), stderr: `` },
            `the planner answered plan format 2, which this platform does not read`,
        ],
        [`a plan that does not say`, { exitCode: 0, stdout: JSON.stringify({ plan: 1 }), stderr: `` }, `the planner's plan does not say whether it would succeed`],
    ])(`reads %s as no plan`, (_, answer, reason) => {
        expect(readPlanAnswer(answer)).toEqual({ kind: `unknown`, reason });
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

    // The probe boots nothing: no daemon, no front door, no restart, and the marker names what to go back to.
    it(`probes with the target image and volume, and the daemon's entrypoint replaced`, () => {
        const probe = probeConfig(target(), OLD);
        expect(probe).toMatchObject({ image: NEW, mounts: [{ volume: `vol_1`, path: `/data` }], restart: { policy: `no` } });
        expect(probe.init?.entrypoint?.slice(0, 2)).toEqual([`/bin/sh`, `-c`]);
        expect(probe.env[STATE_PROBE_ENV]).toBe(OLD);
        expect(probe.services).toBeUndefined();
        expect(probe.checks).toBeUndefined();
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
        [`an answer that is not a plan`, () => ({ exit_code: 0, stdout: `garbage`, stderr: `` })],
    ])(`switches as before the gate on %s`, async (_, answer) => {
        const fly = seeded(`stopped`);
        fly.commands.answer = answer;
        await switchHostedImage(config, MACHINE, target(), { start: true, logger });
        expect(configOf(fly)).toEqual(target());
        expect(stateOf(fly)).toBe(`started`);
    });

    it(`switches as before the gate when the probe itself cannot be asked`, async () => {
        const fly = seeded(`stopped`);
        fly.commands.answer = () => {
            throw new Error(`exec is down`);
        };
        await switchHostedImage(config, MACHINE, target(), { start: true, logger });
        expect(configOf(fly)).toEqual(target());
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
