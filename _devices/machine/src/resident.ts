import { rm } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { plural } from "@intentic/base/format";
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
import type { PeerLink } from "@intentic/sandbox-contract/peer-dial";
import { MACHINE_AUTOSTART } from "./autostart.js";
import { startAutoPrepare } from "./device/auto-prepare.js";
import { type HostLink, LINK_STAMP_MS, type LinkReading, linkStatePath, readLinks, stampLinkStates } from "./device/config.js";
import { connect } from "./device/connection.js";
import { baseDir, runLogPath, runPidPath } from "./config.js";
import { mirrorHeartbeatPath, readState } from "./sync/config.js";
import { runMirrorWatch, signalExitCode } from "./sync/mirror.js";
import { MACHINE_VERSION } from "./version.js";

// The one resident process on this machine, serving both halves at once: the outbound WebSocket per linked
// sandbox (device/connection.ts) and the mirror watcher (sync/mirror.ts). One process replaces what used to be
// two agents, two pidfiles, two updaters. Config changes are picked up differently by each half deliberately:
// sync re-reads its pairing list every tick, while the device half's link list is fixed at startup, so every
// `setup`/`uninstall` restarts this process (reconcileResidency) rather than poking it.

export const machineLauncher = (): CliLauncher => cliLauncher("intentic-machine");

// The pid in the shared pidfile, if the agent that wrote it is still running in this boot.
export const readResidentPid = async (): Promise<number | undefined> => (await livePidRecord(runPidPath))?.pid;

// Which build is actually SERVING: what the agent stamped into the pidfile when it claimed it, the only place
// that fact exists. The binary on disk can be replaced under a running agent without touching the process, so
// this and the installed build (installed.ts) drift; everything that reads liveness reads this beside the pid.
export const readResidentBuild = async (): Promise<string | undefined> => (await livePidRecord(runPidPath))?.note;

// How long to wait for a signalled agent to actually exit, and how often to look. It sleeps between polls, so
// this bound only covers one wedged in a fetch.
const RESIDENT_EXIT_TIMEOUT_MS = 2000;
const RESIDENT_EXIT_POLL_MS = 50;

// Start the agent so it outlives the terminal that launched it. Idempotent: a live agent already serves
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

// Stop the resident agent, signalled AND gone, not merely signalled. It re-reads sync state every tick and
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
    // The heartbeat goes with the pidfile, always: a stopped agent must not leave a stamp for the next reader to age.
    await cleanup();
    return pid;
};

// What a leaving agent must not leave behind: a pidfile claiming a gone pid, a heartbeat reading as a recent
// pass, and a link stamp reading as a live socket.
const cleanup = async (): Promise<void> => {
    await rm(runPidPath, { force: true });
    await rm(mirrorHeartbeatPath, { force: true });
    await rm(linkStatePath, { force: true });
};

// The agent after a change it absorbs by itself: started only if nothing is serving, and silent when something
// is. This process also holds the outbound socket to every linked sandbox, so bouncing it for a change the
// mirror watcher already re-reads each tick would drop the connection the change was asked for over.
export const startResidentIfStopped = async (log: Log): Promise<void> => {
    if ((await readResidentPid()) === undefined) {
        await startResident(log);
    }
};

// Bring the resident state in line with the config: restart when there is anything to serve, retire the login
// entry when there is nothing. The stop comes first even when a restart follows, since the running agent fixes
// its link list at startup and would otherwise keep serving the old config indefinitely — but the READ comes before
// the stop, so a config this build cannot read leaves the agent that is already serving it alone.
export const reconcileResidency = async (log: Log): Promise<void> => {
    const [links, state] = await Promise.all([readLinks(), readState()]);
    await stopResident();
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

// The device half's other tick: publish what each link's socket is doing, since the only process that knows is
// this one and the only process that is asked is `status`, in another terminal (device/config.ts says what that
// gap used to print). Index-aligned with the links the connections were built from.
// Answers the stop, so a machine with nothing linked (sync-only, and legitimate) needs no case of its own here.
const stampLinks = (links: readonly HostLink[], connections: readonly PeerLink[]): (() => void) => {
    if (links.length === 0) {
        return () => undefined;
    }
    const reading = (connection: PeerLink | undefined): LinkReading => {
        const outage = connection?.outage();
        return { state: connection?.state() ?? "closed", ...(outage === undefined ? {} : { outage }) };
    };
    const stamp = (): void => void stampLinkStates(Object.fromEntries(links.map((link, at) => [link.sandboxUrl, reading(connections[at])] as const)));
    stamp();
    const timer = setInterval(stamp, LINK_STAMP_MS);
    // The sockets are what keep this process alive; a stamp timer must never be the reason it outlives them.
    timer.unref();
    return () => clearInterval(timer);
};

// Claims the shared pidfile for this process, or reports who holds it. Two agents tear down each other's sessions
// rather than merely wasting a process, so the loser leaves; it is the caller's job to exit 0 after, since a
// supervisor told this was a failure would restart it into losing again.
const claimResidency = async (log: Log): Promise<boolean> => {
    const holder = await readResidentPid();
    if (holder !== undefined && holder !== process.pid) {
        log(`a machine agent is already running (pid ${holder}): leaving it alone. Stop it with \`intentic-machine run --stop\` first.`);
        return false;
    }
    // Stamped with the build claiming it, so every other process can tell what is SERVING from what is installed
    // (readResidentBuild).
    await writeSecretFile(runPidPath, baseDir, await pidFileBody(process.pid, MACHINE_VERSION));
    return true;
};

// Retires the login entry once this machine has nothing left to come back for. A read that fails keeps the entry:
// retiring it is a decision nothing but a fresh install undoes, and an unreadable config is not evidence for one.
const retireIfNothingToServe = async (log: Log, said: string): Promise<void> => {
    const [links, state] = await Promise.all([readLinks(), readState()]).catch(() => [undefined, undefined] as const);
    if (links?.length === 0 && state?.pairings.length === 0) {
        await unregisterAutostart(MACHINE_AUTOSTART, log);
        log(said);
    }
};

// The foreground agent, what a supervisor (systemd, launchd, the Windows logon task) runs. On a signal it exits
// 128+SIGNAL, not 0, since exiting 0 told systemd this was a clean stop under `Restart=on-failure` and it never
// restarted a deliberate stop.
export const runForeground = async (log: Log): Promise<void> => {
    if (!(await claimResidency(log))) {
        return;
    }

    // A config this build cannot read is the one case that must NOT reach the branch below: "nothing to serve" retires
    // the login entry, and nothing but a fresh install puts it back. Thrown rather than swallowed, so the exit is
    // non-zero and the supervisor that exists for exactly this restarts into another attempt.
    const [links, state] = await Promise.all([readLinks(), readState()]).catch(async (error: unknown) => {
        await cleanup();
        throw error;
    });
    if (links.length === 0 && state.pairings.length === 0) {
        // Terminal, and said once: this runs at every login, and a agent that treated it as a bad tick would log the
        // same line every few seconds for the session's life.
        log("nothing to serve: no sandbox is linked to this device and none is paired for sync. Connect one from a card in your sandbox.");
        await unregisterAutostart(MACHINE_AUTOSTART, log);
        await cleanup();
        return;
    }

    // The login entry, re-asserted by the one process that knows there is still something to come back for. Registered
    // without starting anything: this agent IS the thing the entry would start. An entry lost to a tidied Run key, a
    // reset profile or an uninstall of something adjacent comes back on the next start instead of never.
    await registerAutostart(MACHINE_AUTOSTART, machineLauncher(), log, { startNow: false });

    // The device half: one outbound socket per linked sandbox, each with its own token, grant and retry agent.
    // Nothing is multiplexed or shared but this log.
    const connections = links.map((link) => connect(link, MACHINE_VERSION, log));
    const autoPrepare = deviceTick(links.length, log);
    const stopStamping = stampLinks(links, connections);
    const shutdown = (signal: NodeJS.Signals): void => {
        autoPrepare?.stop();
        stopStamping();
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
        log(`serving ${plural(links.length, "linked sandbox")}`);
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
    await retireIfNothingToServe(log, "nothing left to serve: agent exiting. Reconnect from a card in your sandbox.");
    await cleanup();
};
