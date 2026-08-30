import { rm } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import {
    type CliLauncher,
    cliLauncher,
    isProcessAlive,
    livePid,
    type Log,
    pidFileBody,
    registerAutostart,
    spawnDetached,
    unregisterAutostart,
    writeSecretFile,
} from "@intentic/local-agent";
import { MACHINE_AUTOSTART } from "./autostart.js";
import { startAutoPrepare } from "./computer/auto-prepare.js";
import { readLinks } from "./computer/config.js";
import { connect } from "./computer/connection.js";
import { baseDir, runLogPath, runPidPath } from "./config.js";
import { mirrorHeartbeatPath, readState } from "./sync/config.js";
import { runMirrorWatch, signalExitCode } from "./sync/mirror.js";
import { MACHINE_VERSION } from "./version.js";

/* THE ONE RESIDENT PROCESS on this machine, serving both halves of the agent at once: the outbound WebSocket per
 * linked sandbox (computer/connection.ts) and the mirror watcher that holds the SSH transports, the port
 * forwards and the git bridge for every pairing (sync/mirror.ts).
 *
 * One process is the point of the merge. The two agents this replaces each kept a resident loop, a pidfile, a
 * logon entry and an updater, which was twice the RAM, twice the downloads, and two half-answers to "is this
 * machine's agent running". Nothing about the halves themselves changed: they share this loop, this pidfile and
 * this log, and nothing else.
 *
 * LIFETIMES, and who decides them:
 *   - The computer half runs for as long as its links exist: a connection's `done` resolves only when it is
 *     asked to stop, so a machine with links keeps this process alive indefinitely (reconnection is the normal
 *     case, handled inside each connection).
 *   - The sync half returns on its own when the last pairing is gone (revoked in the browser, or unpaired),
 *     which must NOT take the process down while links remain: the loop keeps serving them.
 *   - When BOTH halves are empty the process exits and takes the autostart entry with it: `run` fires at every
 *     login, and a resident process holding no connections and mirroring nothing is a thing in the process list
 *     that does not do anything, on the machine of somebody who has disconnected from everything.
 *
 * Config changes are picked up two ways, deliberately different: the sync half re-reads its pairing list every
 * tick, while the computer half's link list is fixed at startup — which is why every `setup` and `uninstall`
 * restarts this process (reconcileResidency) rather than poking it. */

export const machineLauncher = (): CliLauncher => cliLauncher("intentic-machine");

// The pid in the shared pidfile, if the loop that wrote it is still running in this boot.
export const readResidentPid = async (): Promise<number | undefined> => await livePid(runPidPath);

// How long to wait for a signalled loop to actually exit, and how often to look. It spends its life asleep
// between polls, so it answers a signal in milliseconds; this bound only covers one wedged in a fetch.
const RESIDENT_EXIT_TIMEOUT_MS = 2000;
const RESIDENT_EXIT_POLL_MS = 50;

// Start the loop so it outlives the terminal that launched it, its stdout appended to the shared log (on
// Windows through the intentic-launch stub, see @intentic/local-agent's detached.ts). Idempotent: a live loop
// already serves everything this machine holds, so a second start is a no-op.
export const startResident = async (log: Log): Promise<void> => {
    const existing = await readResidentPid();
    if (existing !== undefined) {
        log(`the machine agent is already running (pid ${existing}).`);
        return;
    }
    const pid = await spawnDetached(runLogPath, machineLauncher(), MACHINE_AUTOSTART.foregroundArgs);
    log(`machine agent running in the background (pid ${pid}). Details: ${runLogPath}`);
};

/* Stop the resident loop, signalled AND gone, not merely signalled. It re-reads the sync state every tick and
 * writes port baselines back into it, and on Windows it holds the agent binary open, so a caller that is about
 * to replace either must wait it out. Bounded, because a loop that won't die is not a reason to fail the
 * command that asked for this. The forwards stay up; Mutagen's daemon holds them. */
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
    // The heartbeat goes with the pidfile, always: a loop that has been stopped must not leave a stamp behind
    // for the next reader to age; the next loop writes its own on its first completed pass.
    await cleanup();
    return pid;
};

// What a leaving loop must not leave behind: a pidfile claiming a pid that is gone, and a heartbeat that reads
// as a pass finishing moments ago.
const cleanup = async (): Promise<void> => {
    await rm(runPidPath, { force: true });
    await rm(mirrorHeartbeatPath, { force: true });
};

/* Bring the resident state in line with the config: restart the loop when there is anything to serve, retire it
 * (and the login entry) when there is nothing. THE one call every setup and uninstall makes after changing
 * either half's config, which is what makes "stop the old binary, register autostart, cover this session" a
 * single behaviour instead of four slightly different copies of it.
 *
 * The stop comes first even when a restart follows: the running loop is the agent binary this very command may
 * just have replaced, and it fixes the link list at startup, so a loop left running would keep serving the old
 * config with the old code indefinitely, while `run` reported "already running" as if that were the same thing. */
export const reconcileResidency = async (log: Log): Promise<void> => {
    await stopResident();
    const [links, state] = await Promise.all([readLinks(), readState()]);
    if (links.length === 0 && state.pairings.length === 0) {
        await unregisterAutostart(MACHINE_AUTOSTART, log);
        return;
    }
    // registerAutostart answers true when the OS mechanism also started this session (a systemd user unit's
    // `enable --now` does). Where it doesn't, or where there is no mechanism at all, we cover the session.
    if (!(await registerAutostart(MACHINE_AUTOSTART, machineLauncher(), log))) {
        await startResident(log);
    }
};

/* The computer half's background tick: keep each local sandbox's next update downloaded
 * (computer/auto-prepare.ts), so the update card offers a half-minute restart instead of minutes. Gated on
 * links because a link is how a machine that hosts sandboxes presents — the sync half alone may be mirroring
 * a sandbox that runs somewhere else entirely, and a docker poll there would be a question about containers
 * that aren't. */
const computerTick = (links: number, log: Log): { stop: () => void } | undefined => (links > 0 ? startAutoPrepare(log) : undefined);

/* The foreground loop itself, what a supervisor (systemd, launchd, the Windows launcher stub) runs, and what
 * `run --foreground` shows live.
 *
 * It claims the shared pidfile before doing anything and REFUSES if a live loop already holds it: two of these
 * do real damage rather than merely wasting a process (both reconcile the same forwards from their own baseline
 * and take turns tearing down each other's sessions, observed in the field). That refusal is a CHOICE, so it
 * returns normally and exits 0, a supervisor must not restart a refusing loop into refusing again every
 * RestartSec.
 *
 * ON A SIGNAL IT EXITS 128+SIGNAL, NOT 0 (sync/mirror.ts's signalExitCode carries the incident that bought this
 * rule): a signal is something else deciding this process should stop, and exiting 0 told systemd it was a clean
 * stop under `Restart=on-failure`, which is how a machine's sync was silently off for five hours. systemd never
 * restarts a stop IT initiated whatever the code, so deliberate stops still stay stopped. */
export const runForeground = async (log: Log): Promise<void> => {
    const holder = await readResidentPid();
    if (holder !== undefined && holder !== process.pid) {
        log(`a machine agent is already running (pid ${holder}): leaving it alone. Stop it with \`intentic-machine run --stop\` first.`);
        return;
    }
    await writeSecretFile(runPidPath, baseDir, await pidFileBody());

    const [links, state] = await Promise.all([readLinks(), readState()]);
    if (links.length === 0 && state.pairings.length === 0) {
        // Terminal, and said once: this runs at every login, and a loop that treated it as a bad tick would log
        // the same line every few seconds for the life of the session.
        log("nothing to serve: no sandbox is linked to this computer and none is paired for sync. Connect one from a card in your sandbox.");
        await unregisterAutostart(MACHINE_AUTOSTART, log);
        await cleanup();
        return;
    }

    // The computer half: one outbound socket per linked sandbox, each with its own token, grant and retry loop.
    // There is nothing to multiplex and nothing shared but this log.
    const connections = links.map((link) => connect(link, MACHINE_VERSION, log));
    const autoPrepare = computerTick(links.length, log);
    const shutdown = (signal: NodeJS.Signals): void => {
        autoPrepare?.stop();
        for (const connection of connections) {
            connection.stop();
        }
        // The forwards stay up (Mutagen's daemon holds them) and the sockets die with the process; what must
        // not be left behind is a pidfile claiming a pid that is gone and a heartbeat that reads as fresh.
        void cleanup().finally(() => process.exit(signalExitCode(signal)));
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);

    if (links.length > 0) {
        log(`serving ${links.length} linked sandbox(es)`);
    }
    const halves: Promise<void>[] = connections.map((connection) => connection.done);
    if (state.pairings.length > 0) {
        // The sync half returns when its last pairing is gone; the connections above keep the process alive for
        // as long as links exist, so one half ending never takes the other with it.
        halves.push(runMirrorWatch(log));
    }
    await Promise.all(halves);
    // Every half ended on its own; a timer must not be what keeps a process alive that has nothing to serve.
    autoPrepare?.stop();

    /* Every half has ended on its own (no signal): the sync half ran out of pairings, and there were no links to
     * hold the process. Whether the login entry goes too is re-read rather than remembered — a `setup` may have
     * added a link while the watcher was winding down, and that setup's own restart must find the entry it just
     * registered still there. */
    const [linksNow, stateNow] = await Promise.all([readLinks(), readState()]);
    if (linksNow.length === 0 && stateNow.pairings.length === 0) {
        await unregisterAutostart(MACHINE_AUTOSTART, log);
        log("nothing left to serve: agent exiting. Reconnect from a card in your sandbox.");
    }
    await cleanup();
};
