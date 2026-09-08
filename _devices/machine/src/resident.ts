import { rm } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import {
    type CliLauncher,
    cliLauncher,
    isProcessAlive,
    livePidRecord,
    type Log,
    pidFileBody,
    registerAutostart,
    spawnDetached,
    unregisterAutostart,
    writeSecretFile,
} from "@intentic/local-agent";
import { MACHINE_AUTOSTART } from "./autostart.js";
import { startAutoPrepare } from "./device/auto-prepare.js";
import { readLinks } from "./device/config.js";
import { connect } from "./device/connection.js";
import { baseDir, runLogPath, runPidPath } from "./config.js";
import { mirrorHeartbeatPath, readState } from "./sync/config.js";
import { runMirrorWatch, signalExitCode } from "./sync/mirror.js";
import { MACHINE_VERSION } from "./version.js";

// The one resident process on this machine, serving both halves at once: the outbound WebSocket per linked
// sandbox (device/connection.ts) and the mirror watcher (sync/mirror.ts). One process replaces what used to be
// two loops, two pidfiles, two updaters. Config changes are picked up differently by each half deliberately:
// sync re-reads its pairing list every tick, while the device half's link list is fixed at startup, so every
// `setup`/`uninstall` restarts this process (reconcileResidency) rather than poking it.

export const machineLauncher = (): CliLauncher => cliLauncher("intentic-machine");

// The pid in the shared pidfile, if the loop that wrote it is still running in this boot.
export const readResidentPid = async (): Promise<number | undefined> => (await livePidRecord(runPidPath))?.pid;

// Which build is actually SERVING: what the loop stamped into the pidfile when it claimed it, the only place
// that fact exists. The binary on disk can be replaced under a running loop without touching the process, so
// this and the installed build (installed.ts) drift; everything that reads liveness reads this beside the pid.
export const readResidentBuild = async (): Promise<string | undefined> => (await livePidRecord(runPidPath))?.note;

// How long to wait for a signalled loop to actually exit, and how often to look. It sleeps between polls, so
// this bound only covers one wedged in a fetch.
const RESIDENT_EXIT_TIMEOUT_MS = 2000;
const RESIDENT_EXIT_POLL_MS = 50;

// Start the loop so it outlives the terminal that launched it. Idempotent: a live loop already serves
// everything this machine holds.
export const startResident = async (log: Log): Promise<void> => {
    const existing = await readResidentPid();
    if (existing !== undefined) {
        log(`the machine agent is already running (pid ${existing}).`);
        return;
    }
    const pid = await spawnDetached(runLogPath, machineLauncher(), MACHINE_AUTOSTART.foregroundArgs);
    log(`machine agent running in the background (pid ${pid}). Details: ${runLogPath}`);
};

// Stop the resident loop, signalled AND gone, not merely signalled. It re-reads sync state every tick and
// holds the agent binary open on Windows, so a caller about to replace either must wait it out. The forwards
// stay up; Mutagen's daemon holds them.
export const stopResident = async (): Promise<number | undefined> => {
    const pid = await readResidentPid();
    if (pid !== undefined) {
        try {
            process.kill(pid, "SIGTERM");
        } catch {
            // already gone between the read and the kill, nothing to stop
        }
        for (let waited = 0; waited < RESIDENT_EXIT_TIMEOUT_MS && isProcessAlive(pid); waited += RESIDENT_EXIT_POLL_MS) {
            // oxlint-disable-next-line eslint/no-await-in-loop -- a bounded wait for one pid, by definition serial
            await sleep(RESIDENT_EXIT_POLL_MS);
        }
    }
    // The heartbeat goes with the pidfile, always: a stopped loop must not leave a stamp for the next reader to age.
    await cleanup();
    return pid;
};

// What a leaving loop must not leave behind: a pidfile claiming a gone pid, and a heartbeat reading as a
// recent pass.
const cleanup = async (): Promise<void> => {
    await rm(runPidPath, { force: true });
    await rm(mirrorHeartbeatPath, { force: true });
};

// Bring the resident state in line with the config: restart when there is anything to serve, retire the login
// entry when there is nothing. The stop comes first even when a restart follows, since the running loop fixes
// its link list at startup and would otherwise keep serving the old config indefinitely.
export const reconcileResidency = async (log: Log): Promise<void> => {
    await stopResident();
    const [links, state] = await Promise.all([readLinks(), readState()]);
    if (links.length === 0 && state.pairings.length === 0) {
        await unregisterAutostart(MACHINE_AUTOSTART, log);
        return;
    }
    // registerAutostart answers true when the OS mechanism also started this session (a systemd user unit's
    // `enable --now` does); where it doesn't, this covers the session.
    if (!(await registerAutostart(MACHINE_AUTOSTART, machineLauncher(), log))) {
        await startResident(log);
    }
};

// The device half's background tick: keep each local sandbox's next update downloaded (device/auto-prepare.ts).
// Gated on links, since the sync half alone may be mirroring a sandbox that runs elsewhere entirely.
const deviceTick = (links: number, log: Log): { stop: () => void } | undefined => (links > 0 ? startAutoPrepare(log) : undefined);

// The foreground loop, what a supervisor (systemd, launchd, the Windows launcher stub) runs. Claims the shared
// pidfile and refuses if a live loop already holds it, since two of these tear down each other's sessions
// rather than merely wasting a process; the refusal exits 0 so a supervisor doesn't restart it into refusing
// again. On a signal it exits 128+SIGNAL, not 0, since exiting 0 told systemd this was a clean stop under
// `Restart=on-failure` and it never restarted a deliberate stop.
export const runForeground = async (log: Log): Promise<void> => {
    const holder = await readResidentPid();
    if (holder !== undefined && holder !== process.pid) {
        log(`a machine agent is already running (pid ${holder}): leaving it alone. Stop it with \`intentic-machine run --stop\` first.`);
        return;
    }
    // Stamped with the build claiming it, so every other process can tell what is SERVING from what is installed
    // (readResidentBuild).
    await writeSecretFile(runPidPath, baseDir, await pidFileBody(process.pid, MACHINE_VERSION));

    const [links, state] = await Promise.all([readLinks(), readState()]);
    if (links.length === 0 && state.pairings.length === 0) {
        // Terminal, and said once: this runs at every login, and a loop that treated it as a bad tick would log the
        // same line every few seconds for the session's life.
        log("nothing to serve: no sandbox is linked to this device and none is paired for sync. Connect one from a card in your sandbox.");
        await unregisterAutostart(MACHINE_AUTOSTART, log);
        await cleanup();
        return;
    }

    // The device half: one outbound socket per linked sandbox, each with its own token, grant and retry loop.
    // Nothing is multiplexed or shared but this log.
    const connections = links.map((link) => connect(link, MACHINE_VERSION, log));
    const autoPrepare = deviceTick(links.length, log);
    const shutdown = (signal: NodeJS.Signals): void => {
        autoPrepare?.stop();
        for (const connection of connections) {
            connection.stop();
        }
        // The forwards stay up (Mutagen's daemon holds them) and the sockets die with the process; what must not be
        // left behind is a pidfile claiming a gone pid and a heartbeat reading as fresh.
        void cleanup().finally(() => process.exit(signalExitCode(signal)));
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);

    if (links.length > 0) {
        log(`serving ${links.length} linked sandbox(es)`);
    }
    const halves: Promise<void>[] = connections.map((connection) => connection.done);
    if (state.pairings.length > 0) {
        // The sync half returns when its last pairing is gone; the connections above keep the process alive for as
        // long as links exist, so one half ending never takes the other with it.
        halves.push(runMirrorWatch(log));
    }
    await Promise.all(halves);
    // Every half ended on its own; a timer must not be what keeps a process alive that has nothing to serve.
    autoPrepare?.stop();

    // Every half has ended on its own (no signal). Whether the login entry goes too is re-read rather than
    // remembered, since a `setup` may have added a link while the watcher was winding down.
    const [linksNow, stateNow] = await Promise.all([readLinks(), readState()]);
    if (linksNow.length === 0 && stateNow.pairings.length === 0) {
        await unregisterAutostart(MACHINE_AUTOSTART, log);
        log("nothing left to serve: agent exiting. Reconnect from a card in your sandbox.");
    }
    await cleanup();
};
