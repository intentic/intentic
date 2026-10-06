import { stubGlobal, unstubAllGlobals } from "@intentic/testing/bun";
import { type FakeFly, installFakeFly } from "@intentic/testing/fly-fake";
import type { Config } from "../../../config.js";
import { healthAnswer, machineAnswers, NO_HEALTH } from "../../../testing.js";
import {
    awaitDaemon,
    baselineOf,
    crashLoopOf,
    DAEMON_HEALTH_COMMAND,
    DAEMON_VITALS_COMMAND,
    DAEMON_VITALS_FILE_COMMAND,
    HEALTH_POLL_MS,
    READY_BUDGET_MS,
    readDaemonHealth,
} from "./daemon-health.js";
import * as timersPromisesOriginal from "node:timers/promises";

/* The poll's pause is two seconds of real time in production; the wait is bounded by a count of looks as well. */
jest.mock("node:timers/promises", () => ({
    ...timersPromisesOriginal,
    setTimeout: async () => undefined,
}));

// SAFETY: the wait reads only the Fly token off the config.
const config = { hosted: { flyApiToken: `fly` } } as Config;
const MACHINE = { appName: `intentic-sbx-a`, machineId: `m1` };

const started = (): FakeFly => {
    const fly = installFakeFly((name, value) => stubGlobal(name, value));
    fly.apps.add(MACHINE.appName);
    const at = new Date().toISOString();
    fly.machines.set(`m1`, { id: `m1`, app: MACHINE.appName, region: `iad`, state: `started`, config: {}, createdAt: at, updatedAt: at });
    return fly;
};

afterEach(() => {
    unstubAllGlobals();
});

describe(`reading /health the way ic reads it`, () => {
    it(`reads the boot's readiness and the state journal`, () => {
        expect(readDaemonHealth(JSON.stringify({ boot: { ready: true }, state: { journal: `none`, engine: 3 } }))).toEqual({ ready: true, journal: `closed` });
        expect(readDaemonHealth(JSON.stringify({ boot: { ready: false }, state: { journal: `open` } }))).toEqual({ ready: false, journal: `open` });
        expect(readDaemonHealth(JSON.stringify({ boot: { ready: true }, state: { journal: `failed` } }))).toEqual({ ready: true, journal: `failed` });
    });

    // A daemon older than the boot report, and one older than the conversion engine, answer ready and closed.
    it(`reads a daemon too old to report a boot as ready, and one with no journal as closed`, () => {
        expect(readDaemonHealth(JSON.stringify({ ok: true }))).toEqual({ ready: true, journal: `closed` });
        expect(readDaemonHealth(JSON.stringify({ ready: false }))).toEqual({ ready: false, journal: `closed` });
        // A field of an unexpected shape is a field that is not there, never a reason to drop the whole answer.
        expect(readDaemonHealth(JSON.stringify({ boot: `yes`, state: { journal: 7 } }))).toEqual({ ready: true, journal: `closed` });
    });

    it.each([[``], [`<html>503</html>`], [`[1,2]`], [`"up"`]])(`reads %j as no answer`, (stdout) => {
        expect(readDaemonHealth(stdout)).toBeUndefined();
    });
});

describe(`reading netd's vitals for a crash loop`, () => {
    const vitals = (node: string, restarts: number): string => JSON.stringify({ node, lagMs: null, restarts, uptimeS: 41, pressure: null });

    it(`reads a daemon down after three restarts as one that keeps crashing, and nothing less as one`, () => {
        expect(crashLoopOf(vitals(`restarting`, 3))).toBe(`its daemon kept crashing: netd restarted it 3 times in ten minutes`);
        expect(crashLoopOf(vitals(`restarting`, 2))).toBe(undefined);
        // Restarted three times and up again: it recovered.
        expect(crashLoopOf(vitals(`up`, 5))).toBe(undefined);
        // An older sandbox's Node answering the path, or anything that is not netd's answer.
        expect(crashLoopOf(`<html>not found</html>`)).toBe(undefined);
        expect(crashLoopOf(JSON.stringify({ restarts: 3 }))).toBe(undefined);
    });
});

describe(`waiting for the daemon`, () => {
    it(`asks the daemon's own /health inside the machine, with curl named by its path`, async () => {
        const fly = started();
        fly.commands.answer = machineAnswers({});
        await expect(awaitDaemon(config, MACHINE, await baselineOf(config, MACHINE), undefined)).resolves.toEqual({ kind: `up`, slow: false });
        expect(fly.called(`POST`, `/machines/m1/exec`)[0]?.body).toEqual({ command: [...DAEMON_HEALTH_COMMAND], timeout: 10 });
        expect(DAEMON_HEALTH_COMMAND[0]).toBe(`/usr/bin/curl`);
    });

    // A machine that was already running booted before this wait began: its check-in happened before it, not after.
    it(`waits for no check-in from a machine that was already running`, async () => {
        started().commands.answer = machineAnswers({});
        const checkedIn = jest.fn(async () => false);
        const baseline = await baselineOf(config, MACHINE);
        expect(baseline).toEqual({ read: true, exitedAt: undefined, running: true });
        await expect(awaitDaemon(config, MACHINE, baseline, checkedIn)).resolves.toEqual({ kind: `up`, slow: false });
        expect(checkedIn).not.toHaveBeenCalled();
    });

    // With no baseline an exit cannot be told from an earlier one, so none is read as this start's; the state still is.
    it(`reads no exit as this start's when the machine could not be read before it`, async () => {
        const fly = started();
        const machine = fly.machines.get(`m1`);
        if (machine !== undefined) {
            machine.exit = { exitCode: 1 };
        }
        fly.commands.answer = machineAnswers({});
        await expect(awaitDaemon(config, MACHINE, { read: false, exitedAt: undefined, running: false }, undefined)).resolves.toEqual({ kind: `up`, slow: false });
    });

    // Fly restarts a running machine to apply a config: a clean stop the machine came back from is no verdict at all.
    it(`keeps waiting through a clean stop the machine came back from, and ends only on one it stays down after`, async () => {
        const fly = started();
        fly.commands.answer = machineAnswers({
            health: (asked, machine) => {
                machine.exit = { exitCode: 0 };
                return asked === 0 ? NO_HEALTH : healthAnswer({ boot: { ready: true } });
            },
        });
        await expect(awaitDaemon(config, MACHINE, await baselineOf(config, MACHINE), undefined)).resolves.toEqual({ kind: `up`, slow: false });

        const down = started();
        down.commands.answer = machineAnswers({
            health: (_asked, machine) => {
                machine.exit = { exitCode: 0 };
                machine.state = `stopped`;
                return NO_HEALTH;
            },
        });
        await expect(awaitDaemon(config, MACHINE, await baselineOf(config, MACHINE), undefined)).resolves.toEqual({
            kind: `interrupted`,
            reason: `the machine was stopped while its new version was starting`,
        });
    });

    it(`gives up on a daemon that never answers once the ready budget is spent, and says so in minutes`, async () => {
        const fly = started();
        fly.commands.answer = machineAnswers({ health: () => NO_HEALTH });
        await expect(awaitDaemon(config, MACHINE, await baselineOf(config, MACHINE), undefined)).resolves.toEqual({
            kind: `down`,
            reason: `its daemon did not answer within 3 minutes of starting`,
        });
        const healthAsks = fly.called(`POST`, `/machines/m1/exec`).filter((call) => JSON.stringify(call.body).includes(DAEMON_HEALTH_COMMAND.at(-1) ?? ``));
        expect(healthAsks).toHaveLength(READY_BUDGET_MS / HEALTH_POLL_MS);
    });

    // netd is the machine's PID 1: a daemon that crashes on every start never exits the machine, and its own count of
    // restarts is the verdict, where the budget would have waited three minutes for it.
    it(`goes back at the first look netd says the daemon keeps crashing, and asks netd the way it asks /health`, async () => {
        const fly = started();
        const looping = { exit_code: 0, stdout: `${JSON.stringify({ node: `restarting`, lagMs: null, restarts: 3, uptimeS: 41, pressure: null })}\n`, stderr: `` };
        fly.commands.answer = machineAnswers({ health: () => NO_HEALTH, vitals: () => looping });
        await expect(awaitDaemon(config, MACHINE, await baselineOf(config, MACHINE), undefined)).resolves.toEqual({
            kind: `down`,
            reason: `its daemon kept crashing: netd restarted it 3 times in ten minutes`,
        });
        expect(fly.called(`POST`, `/machines/m1/exec`).map((call) => call.body)).toEqual([
            { command: [...DAEMON_HEALTH_COMMAND], timeout: 10 },
            { command: [...DAEMON_VITALS_COMMAND], timeout: 10 },
        ]);
        expect(DAEMON_VITALS_COMMAND.at(-1)).toBe(`http://localhost:8787/system/vitals`);
    });

    // A daemon that dies before it names netd's ports leaves netd listening on nothing: its file is netd's word then.
    it(`reads netd's vitals file when its address answers nothing, and goes back on what it says`, async () => {
        const fly = started();
        const looping = { exit_code: 0, stdout: JSON.stringify({ node: `restarting`, lagMs: null, restarts: 4, uptimeS: 30, pressure: null }), stderr: `` };
        fly.commands.answer = machineAnswers({ health: () => NO_HEALTH, vitalsFile: () => looping });
        await expect(awaitDaemon(config, MACHINE, await baselineOf(config, MACHINE), undefined)).resolves.toEqual({
            kind: `down`,
            reason: `its daemon kept crashing: netd restarted it 4 times in ten minutes`,
        });
        expect(fly.called(`POST`, `/machines/m1/exec`).map((call) => call.body)).toEqual([
            { command: [...DAEMON_HEALTH_COMMAND], timeout: 10 },
            { command: [...DAEMON_VITALS_COMMAND], timeout: 10 },
            { command: [...DAEMON_VITALS_FILE_COMMAND], timeout: 10 },
        ]);
        expect(DAEMON_VITALS_FILE_COMMAND).toEqual([`/bin/cat`, `/run/intentic/vitals.json`]);
    });

    it(`keeps a daemon still booting when the budget ends with its journal never open, as ic keeps a slow boot`, async () => {
        started().commands.answer = machineAnswers({ health: () => healthAnswer({ boot: { ready: false }, state: { journal: `none` } }) });
        await expect(awaitDaemon(config, MACHINE, await baselineOf(config, MACHINE), undefined)).resolves.toEqual({ kind: `up`, slow: true });
    });
});
