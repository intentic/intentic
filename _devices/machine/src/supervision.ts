import { rm } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import {
    type AutostartKind,
    autostart,
    type CliLauncher,
    cliLauncher,
    livePidRecord,
    type Log,
    type PidRecord,
    releasePidFile,
    spawnDetached,
    stopProcess,
} from "@intentic/local-agent";
import { MACHINE_AUTOSTART } from "./autostart.js";
import { runLogPath, runPidPath } from "./config.js";
import { linkStatePath } from "./device/config.js";
import { attachToWindows, WINDOWS_SUPERVISOR } from "./environments/machine.js";
import { mirrorHeartbeatPath } from "./sync/config.js";

// Every start goes through whoever restarts this environment's agent; a bare detached spawn only where nothing does.

export const machineLauncher = (): CliLauncher => cliLauncher("intentic-machine");

const machineAutostart = (log: Log) => autostart(MACHINE_AUTOSTART, machineLauncher(), log);

export const readResident = async (): Promise<PidRecord | undefined> => await livePidRecord(runPidPath);

// Who restarts this process, as stamped beside its pid: the Windows side for a supervised distro, else the login entry.
export type Supervisor = AutostartKind | typeof WINDOWS_SUPERVISOR;

// Long enough for a supervisor's own restart delay (systemd's RestartSec, the Windows side's first rung) and a cold start.
const START_TIMEOUT_MS = 20_000;
const START_POLL_MS = 200;
// A logon task that is still winding down its last instance ignores /run, so the ask is repeated on this cadence.
const START_REASK_MS = 2_000;
// The agent exits within this on SIGTERM; one wedged in a fetch is waited out no longer.
const STOP_TIMEOUT_MS = 5_000;

const waitForResident = async (timeoutMs: number, reask?: () => Promise<unknown>): Promise<PidRecord | undefined> => {
    const deadline = Date.now() + timeoutMs;
    let askedAt = Date.now();
    while (Date.now() < deadline) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- a bounded poll, serial by definition
        const held = await readResident();
        if (held !== undefined) {
            return held;
        }
        if (reask !== undefined && Date.now() - askedAt >= START_REASK_MS) {
            askedAt = Date.now();
            // oxlint-disable-next-line eslint/no-await-in-loop -- ditto
            await reask();
        }
        // oxlint-disable-next-line eslint/no-await-in-loop -- ditto
        await sleep(START_POLL_MS);
    }
    return undefined;
};

// Signalled AND gone; the stamps go with it only while no replacement has claimed the pidfile in the meantime.
export const stopResident = async (): Promise<number | undefined> => {
    const held = await readResident();
    if (held === undefined) {
        return undefined;
    }
    await stopProcess(held.pid, STOP_TIMEOUT_MS);
    if (await releasePidFile(runPidPath, held.pid)) {
        await rm(mirrorHeartbeatPath, { force: true });
        await rm(linkStatePath, { force: true });
    }
    return held.pid;
};

const started = (log: Log, held: PidRecord, by: string): void =>
    log(`machine agent running in the background (pid ${held.pid}, ${by}). Details: ${runLogPath}`);

// A distro whose Windows side has an agent is started by it, so the one supervisor of this environment is the PC's own.
const startThroughWindows = async (log: Log): Promise<boolean> => {
    if (!(await attachToWindows(log))) {
        return false;
    }
    const held = await waitForResident(START_TIMEOUT_MS);
    if (held === undefined) {
        log("note: the Windows side took this distro over but its agent did not come up here in time; starting it directly.");
        return false;
    }
    started(log, held, "kept running by the Windows side");
    return true;
};

// Idempotent: a live agent already serves everything this environment holds, since it re-reads its config every tick.
export const startResident = async (log: Log): Promise<void> => {
    const running = await readResident();
    if (running !== undefined) {
        return;
    }
    if (await startThroughWindows(log)) {
        return;
    }
    const entry = machineAutostart(log);
    const kind = await entry.register();
    if (await entry.start()) {
        const held = await waitForResident(START_TIMEOUT_MS, async () => await entry.start());
        if (held !== undefined) {
            started(log, held, `started by its ${kind} entry`);
            return;
        }
        log(`note: the ${kind} login entry did not start the agent within ${START_TIMEOUT_MS / 1000}s; starting it directly.`);
    }
    const pid = await spawnDetached(runLogPath, machineLauncher(), MACHINE_AUTOSTART.foregroundArgs);
    log(`machine agent running in the background (pid ${pid}). Details: ${runLogPath}`);
};

export const restartResident = async (log: Log): Promise<void> => {
    await stopResident();
    await startResident(log);
};

// Stops the agent and takes its login entry away. A distro the Windows side supervises is let go by its own exit 0.
export const retireResident = async (log: Log): Promise<void> => {
    await stopResident();
    await machineAutostart(log).unregister();
};

// Made once by the running agent: one starter per environment, so a distro the Windows side runs has no entry of its own.
export const assertSupervisor = async (supervised: boolean, log: Log): Promise<Supervisor> => {
    const entry = machineAutostart(log);
    if (supervised) {
        await entry.unregister();
        return WINDOWS_SUPERVISOR;
    }
    if (await attachToWindows(log)) {
        await entry.unregister();
        return "none";
    }
    return await entry.register({ repair: true });
};
