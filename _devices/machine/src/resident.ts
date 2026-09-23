import { rm } from "node:fs/promises";
import { constants } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { errorMessage } from "@intentic/base/errors";
import { plural } from "@intentic/base/format";
import { autostart, claimPidFile, holdPidFile, type Log, type PidRecord, releasePidFile, stopProcess } from "@intentic/local-agent";
import type { PeerLink } from "@intentic/sandbox-contract/peer-dial";
import { MACHINE_AUTOSTART } from "./autostart.js";
import { baseDir, runPidPath } from "./config.js";
import { startAutoPrepare } from "./device/auto-prepare.js";
import { type HostLink, LINK_STAMP_MS, type LinkReading, linkStatePath, readLinks, stampLinkStates } from "./device/config.js";
import { connect } from "./device/connection.js";
import { type Children, superviseChildren } from "./environments/children.js";
import { type AutoUpgrade, startAutoUpgrade } from "./environments/auto-upgrade.js";
import { heldDistros, SUPERVISOR_ENV, supervisedByWindows, updateMachineConfig, withoutChild } from "./environments/machine.js";
import { UPGRADE_ENV } from "./environments/machine-upgrade.js";
import { sweepBin } from "./release.js";
import { assertSupervisor, machineLauncher, readResident, retireResident, startResident } from "./supervision.js";
import { mirrorHeartbeatPath, readState } from "./sync/config.js";
import { runMirrorWatch } from "./sync/mirror.js";
import { MACHINE_VERSION } from "./version.js";
import { WINDOWS_SIDE } from "./wsl.js";

// This environment's one resident process; it re-reads what it serves every tick, so only a new binary or `run` restarts it.

export const readResidentPid = async (): Promise<number | undefined> => (await readResident())?.pid;

// Which build is SERVING: the binary on disk can be replaced under a running agent, so only its own stamp says.
export const readResidentBuild = async (): Promise<string | undefined> => (await readResident())?.build;

// 128+signal, never 0: a supervisor must restart what it did not stop.
export const signalExitCode = (signal: NodeJS.Signals): number => 128 + (constants.signals[signal] ?? 15);

// Another agent took over this environment's pidfile; non-zero so a supervisor may try again and find it holding.
export const EXIT_REPLACED = 75;

// How often config, links, the lease and the distros held from here are re-read.
const TICK_MS = LINK_STAMP_MS;

// What this environment serves: links (device half), pairings (sync half) and, on Windows, the distros it keeps running.
interface Served {
    readonly links: readonly HostLink[];
    readonly pairings: number;
    readonly children: readonly string[];
}

// Throws on a file that exists and will not parse: "nothing to serve" retires the login entry, which only a fresh install undoes.
const readServed = async (): Promise<Served> => {
    const [links, state, children] = await Promise.all([readLinks(), readState(), heldDistros()]);
    return { links, pairings: state.pairings.length, children };
};

const nothingToServe = (served: Served): boolean => served.links.length === 0 && served.pairings === 0 && served.children.length === 0;

// The agent after a change it absorbs by itself: started if nothing is running, retired once nothing is left to serve.
export const ensureResident = async (log: Log): Promise<void> => {
    if (nothingToServe(await readServed())) {
        await retireResident(log);
        return;
    }
    await startResident(log);
};

// A supervised distro takes over from whatever copy runs there unsupervised; anything else leaves a live holder alone.
const claim = async (record: PidRecord, supervised: boolean, log: Log): Promise<boolean> => {
    if (supervised) {
        await autostart(MACHINE_AUTOSTART, machineLauncher(), log).unregister();
        const holder = await readResident();
        if (holder !== undefined && holder.pid !== process.pid) {
            log(`taking over from the agent already running here (pid ${holder.pid}), since the Windows side keeps this distro's agent running.`);
            await stopProcess(holder.pid, 5_000);
        }
    }
    const claimed = await claimPidFile(runPidPath, baseDir, record);
    if (!claimed.claimed) {
        log(`a machine agent is already running (pid ${claimed.holder.pid}): leaving it alone. Stop it with \`intentic-machine run --stop\` first.`);
    }
    return claimed.claimed;
};

// The pidfile and the stamps that vouch for a running agent go when it does, unless a successor already claimed them.
const release = async (): Promise<void> => {
    if (await releasePidFile(runPidPath, process.pid)) {
        await rm(mirrorHeartbeatPath, { force: true });
        await rm(linkStatePath, { force: true });
    }
};

interface Connection {
    readonly link: HostLink;
    readonly peer: PeerLink;
}

// Same sandbox, same enrollment: a scope push rewrites the file without changing either, and must not redial.
const sameEnrollment = (a: HostLink, b: HostLink): boolean => a.id === b.id && a.token === b.token;

// Dials what the config links and closes what it no longer does, so a revoked or re-enrolled link needs no restart.
export const reconcileLinks = (
    connections: Map<string, Connection>,
    links: readonly HostLink[],
    dial: (link: HostLink) => PeerLink,
    log: Log,
): void => {
    const wanted = new Map(links.map((link) => [link.sandboxUrl, link]));
    for (const [url, held] of connections) {
        const next = wanted.get(url);
        if (next === undefined || !sameEnrollment(held.link, next)) {
            held.peer.stop();
            connections.delete(url);
            if (next === undefined) {
                log(`${url}: no longer linked, its connection is closed.`);
            }
        }
    }
    for (const [url, link] of wanted) {
        if (!connections.has(url)) {
            connections.set(url, { link, peer: dial(link) });
        }
    }
};

const reading = (peer: PeerLink): LinkReading => {
    const outage = peer.outage();
    return { state: peer.state(), ...(outage === undefined ? {} : { outage }) };
};

const stampLinks = async (connections: ReadonlyMap<string, Connection>): Promise<void> => {
    if (connections.size > 0) {
        await stampLinkStates(Object.fromEntries([...connections].map(([url, held]) => [url, reading(held.peer)] as const)));
    }
};

// A sync half that fails to start is retried on this ladder, so a Mutagen download that keeps failing is not a loop.
const SYNC_RETRY_MS = [60_000, 120_000, 300_000, 600_000];

interface SyncHalf {
    running: Promise<void> | undefined;
    failures: number;
    retryAt: number;
}

// The sync half ends by itself when its last pairing goes; a pairing added later starts it again in this same process.
const startSyncIfDue = (sync: SyncHalf, pairings: number, log: Log): void => {
    if (pairings === 0 || sync.running !== undefined || Date.now() < sync.retryAt) {
        return;
    }
    sync.running = runMirrorWatch(log)
        .then(() => {
            sync.failures = 0;
        })
        .catch((error: unknown) => {
            sync.retryAt = Date.now() + (SYNC_RETRY_MS[Math.min(sync.failures, SYNC_RETRY_MS.length - 1)] ?? 600_000);
            sync.failures += 1;
            log(`sync stopped: ${errorMessage(error)}. Trying again later.`);
        })
        .finally(() => {
            sync.running = undefined;
        });
};

interface Runtime {
    readonly connections: Map<string, Connection>;
    readonly sync: SyncHalf;
    readonly children: Children | undefined;
    readonly autoUpgrade: AutoUpgrade | undefined;
    readonly finish: (code: number) => Promise<never>;
}

// The machine-wide duties (the one Docker engine's next images, the PC's own upgrades) are the root's alone.
const runtimeOf = (supervised: boolean, log: Log): Runtime => {
    const connections = new Map<string, Connection>();
    const children = WINDOWS_SIDE
        ? superviseChildren(log, async (distro) => void (await updateMachineConfig((config) => withoutChild(config, distro))))
        : undefined;
    const autoPrepare = supervised ? undefined : startAutoPrepare(log);
    const autoUpgrade = supervised ? undefined : startAutoUpgrade(log);
    const finish = async (code: number): Promise<never> => {
        autoPrepare?.stop();
        autoUpgrade?.stop();
        children?.stopAll();
        for (const held of connections.values()) {
            held.peer.stop();
        }
        await release();
        process.exit(code);
    };
    for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
        process.on(signal, () => void finish(signalExitCode(signal)));
    }
    return { connections, sync: { running: undefined, failures: 0, retryAt: 0 }, children, autoUpgrade, finish };
};

// One pass: the lease first, since everything after it acts on this environment as its one agent.
const tick = async (runtime: Runtime, lease: PidRecord, log: Log): Promise<void> => {
    if (!(await holdPidFile(runPidPath, baseDir, lease))) {
        log("another machine agent took this environment over: leaving.");
        await runtime.finish(EXIT_REPLACED);
    }
    const now = await readServed().catch((error: unknown) => {
        log(`config unreadable (${errorMessage(error)}): keeping what already runs.`);
        return undefined;
    });
    if (now !== undefined) {
        reconcileLinks(runtime.connections, now.links, (link) => connect(link, MACHINE_VERSION, log), log);
        const held = runtime.children?.held() ?? [];
        runtime.children?.reconcile(now.children);
        if (now.children.some((distro) => !held.includes(distro))) {
            runtime.autoUpgrade?.nudge();
        }
        startSyncIfDue(runtime.sync, now.pairings, log);
        if (nothingToServe(now) && runtime.sync.running === undefined) {
            log("nothing left to serve: agent exiting. Reconnect from a card in your sandbox.");
            await autostart(MACHINE_AUTOSTART, machineLauncher(), log).unregister();
            await runtime.finish(0);
        }
    }
    await stampLinks(runtime.connections);
};

// Claims the environment and settles its supervisor; undefined when another agent holds it or nothing is left to serve.
const begin = async (supervised: boolean, log: Log): Promise<{ readonly served: Served; readonly lease: PidRecord } | undefined> => {
    const record: PidRecord = { pid: process.pid, build: MACHINE_VERSION };
    if (!(await claim(record, supervised, log))) {
        return undefined;
    }
    const served = await readServed().catch(async (error: unknown) => {
        await release();
        throw error;
    });
    if (nothingToServe(served)) {
        // Said once: this runs at every login, and a loop over it would say it every few seconds.
        log("nothing to serve: no sandbox is linked to this device and none is paired for sync. Connect one from a card in your sandbox.");
        await autostart(MACHINE_AUTOSTART, machineLauncher(), log).unregister();
        await release();
        return undefined;
    }
    const lease: PidRecord = { ...record, supervisor: await assertSupervisor(supervised, log) };
    await holdPidFile(runPidPath, baseDir, lease);
    await sweepBin();
    return { served, lease };
};

const serving = (served: Served): string =>
    [
        plural(served.links.length, "linked sandbox"),
        plural(served.pairings, "sync pairing"),
        ...(WINDOWS_SIDE ? [plural(served.children.length, "WSL distro")] : []),
    ].join(", ");

// The foreground agent a supervisor runs (systemd, launchd, the logon task, or the Windows side for a distro).
export const runForeground = async (log: Log): Promise<void> => {
    // Read once and cleared, so no process this one starts (a shell, an upgrade) inherits a role that was never its own.
    const supervised = supervisedByWindows();
    delete process.env[SUPERVISOR_ENV];
    delete process.env[UPGRADE_ENV];
    const started = await begin(supervised, log);
    if (started === undefined) {
        return;
    }
    const runtime = runtimeOf(supervised, log);
    log(`serving ${serving(started.served)}`);
    for (;;) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- the tick loop itself, serial by definition
        await tick(runtime, started.lease, log);
        // oxlint-disable-next-line eslint/no-await-in-loop -- ditto
        await sleep(TICK_MS);
    }
};
