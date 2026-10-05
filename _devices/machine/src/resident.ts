import { rm } from "node:fs/promises";
import { constants } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { errorMessage } from "@intentic/base/errors";
import { plural } from "@intentic/base/format";
import { autostart, claimPidFile, holdPidFile, type Log, type PidRecord, releasePidFile, stopProcess } from "@intentic/local-agent";
import type { PeerLink } from "@intentic/sandbox-contract/peer-dial";
import { beginTrial, type Trial } from "./agent-trial.js";
import { MACHINE_AUTOSTART } from "./autostart/autostart.js";
import { baseDir, runPidPath } from "./config.js";
import { startAutoBackup } from "./device/sandbox-rounds/auto-backup.js";
import { startAutoPrepare } from "./device/sandbox-rounds/auto-prepare.js";
import { type HostLink, LINK_STAMP_MS, type LinkReading, linkStatePath, readLinks, stampLinkStates } from "./device/config.js";
import { connect, reachedOverLoopback } from "./device/connection.js";
import { hostedSlugs, keeperOn, startKeeper } from "./device/sandbox-rounds/keeper.js";
import { startProbationWatch } from "./device/sandbox-rounds/probation-watch.js";
import { readChannelSlugs } from "./device/sandbox-rounds/swap-records.js";
import { fleet } from "./device/tools/sandboxes.js";
import { takeOverCommandLedger } from "./device/tools/command-ledger.js";
import { stopRunningCommands } from "./device/tools/shell.js";
import { type Children, superviseChildren } from "./environments/children.js";
import { type AutoUpgrade, startAutoUpgrade } from "./environments/auto-upgrade.js";
import { heldDistros, SUPERVISOR_ENV, supervisedByWindows, updateMachineConfig, withoutChild } from "./environments/machine.js";
import { UPGRADE_ENV } from "./environments/machine-upgrade.js";
import { sweepBin } from "./release.js";
import { assertSupervisor, machineLauncher, readResident, retireResident, startResident } from "./supervision.js";
import { mirrorHeartbeatPath, readState } from "./sync/config.js";
import { runMirrorWatch } from "./sync/mirror.js";
import { startUpkeep } from "./upkeep/reconcile.js";
import { MACHINE_VERSION } from "./version.js";
import { startWatchdog } from "./watchdog.js";
import { WINDOWS_SIDE } from "./wsl.js";

// This environment's one resident process; it re-reads what it serves every tick, so only a new binary or `run` restarts it.

export const readResidentPid = async (): Promise<number | undefined> => (await readResident())?.pid;

// Which build is SERVING: the binary on disk can be replaced under a running agent, so only its own stamp says.
export const readResidentBuild = async (): Promise<string | undefined> => (await readResident())?.build;

// 128+signal, never 0: a supervisor must restart what it did not stop.
export const signalExitCode = (signal: NodeJS.Signals): number => 128 + (constants.signals[signal] ?? 15);

// Another agent took over this environment's pidfile; non-zero so a supervisor may try again and find it holding.
export const EXIT_REPLACED = 75;

// This release kept crashing and the agent before it was put back (agent-trial.ts); non-zero so the supervisor starts
// the binary now in its place.
export const EXIT_ROLLED_BACK = 76;

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

/* THE ONE MORE REASON TO STAY: the sandboxes this machine hosts, while the keeper (sandbox-rounds/keeper.ts) is on. With
   no link, no pairing and no distro the agent used to take its login entry away and exit, and then nothing started
   Docker Desktop after the next reboot: a sandbox on this machine stayed down until someone came to it. So an agent with
   nothing else to serve stays while ic lists a sandbox here (or, with Docker down, keeps a record of one) and the keeper
   is on; `intentic-machine sandbox keeper off` or `uninstall` lets it go. A machine.json that does not read counts as on,
   since retiring on a guess is the one move here that needs a person to undo it. */
export const keptSandboxes = async (): Promise<readonly string[]> => {
    // allow(silent-catch): an unreadable switch keeps the agent, the reversible answer (above)
    const on = await keeperOn().catch(() => true);
    // Only this environment's own: a sandbox the other side of this PC keeps is that side's agent's reason to stay
    // (`keptElsewhere`, keeper.ts), and counting it here kept a distro's agent resident for a sandbox it never serves.
    return on
        ? await hostedSlugs(
              async () => (await fleet({ current: false })).map(({ slug, keptElsewhere }) => ({ slug, keptElsewhere })),
              async () => await readChannelSlugs(),
          )
        : [];
};

const keptNote = (kept: readonly string[]): string =>
    `this machine runs ${plural(kept.length, "sandbox", "sandboxes")} (${kept.join(", ")}), so the agent stays to bring ${kept.length === 1 ? "it" : "them"} back after a restart. \`intentic-machine sandbox keeper off\` lets it go.`;

// The agent after a change it absorbs by itself: started if nothing is running, retired once nothing is left to serve.
// `forGood` is `uninstall`, which retires it whatever this machine hosts.
export const ensureResident = async (log: Log, { forGood = false }: { readonly forGood?: boolean } = {}): Promise<void> => {
    if (nothingToServe(await readServed())) {
        const kept = forGood ? [] : await keptSandboxes();
        if (kept.length === 0) {
            await retireResident(log);
            return;
        }
        log(`Nothing is linked or paired here any more, but ${keptNote(kept)}`);
    }
    await startResident(log);
};

// How often an agent with nothing else to serve asks again whether this machine still hosts a sandbox: an ic listing is
// too dear for every tick, and a sandbox removed a few minutes ago is no reason to hurry.
const KEPT_RECHECK_MS = 5 * 60_000;

// The last answer and when it was asked; never asked is -Infinity, so the first agent with nothing to serve always asks.
export interface KeptCheck {
    at: number;
    kept: readonly string[];
}

// The answer, asked again once it is KEPT_RECHECK_MS old; said when the agent starts staying for it.
export const stillKeeping = async (
    check: KeptCheck,
    log: Log,
    { ask = keptSandboxes, now = Date.now }: { readonly ask?: () => Promise<readonly string[]>; readonly now?: () => number } = {},
): Promise<boolean> => {
    if (now() - check.at >= KEPT_RECHECK_MS) {
        const before = check.kept.length;
        check.kept = await ask();
        check.at = now();
        if (before === 0 && check.kept.length > 0) {
            log(`nothing is linked or paired here any more, but ${keptNote(check.kept)}`);
        }
    }
    return check.kept.length > 0;
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
    readonly kept: KeptCheck;
    readonly children: Children | undefined;
    readonly autoUpgrade: AutoUpgrade | undefined;
    readonly finish: (code: number) => Promise<never>;
}

// Every environment keeps its OWN sandboxes: the next images, the daily backups and tidy, the probation watch and its
// sweep, and the keeper. ic decides which sandboxes are whose from the side stamped on each container (ic:
// sandbox/side.rs) and leaves the others to the environment that made them, so a WSL distro sharing the Windows side's
// engine is not touched twice and is not left untouched either. A supervised distro runs its rounds later than the root,
// so the two sides never pull or back up on the one engine in the same minutes. Only the PC's own upgrades stay the
// root's: it brings its distros along (environments/auto-upgrade.ts).
// How much later a supervised distro's first prepare and backup come than the root's, so the two sides of one PC never
// pull images or read the engine's disks at the same time.
const SUPERVISED_ROUND_DELAY_MS = 30 * 60_000;

const runtimeOf = (supervised: boolean, trial: Trial, kept: KeptCheck, lease: PidRecord, log: Log): Runtime => {
    const connections = new Map<string, Connection>();
    const children = WINDOWS_SIDE
        ? superviseChildren(log, async (distro) => void (await updateMachineConfig((config) => withoutChild(config, distro))))
        : undefined;
    const watch = startProbationWatch(log, { sweeps: true });
    const keeper = startKeeper(log, {
        links: () => [...connections].map(([url, held]) => ({ url, reading: reading(held.peer) })),
        loopback: reachedOverLoopback,
        watching: watch.running,
    });
    const later = supervised ? SUPERVISED_ROUND_DELAY_MS : 0;
    // The device's own upkeep runs everywhere too: each environment holds its own leftovers and stores (upkeep/).
    const upkeep = startUpkeep(log, lease.supervisor);
    const rounds = [watch, keeper, startAutoPrepare(log, { delayMs: later }), startAutoBackup(log, { delayMs: later }), upkeep];
    const autoUpgrade = supervised ? undefined : startAutoUpgrade(log);
    const unproven = trial.prove(log);
    const finish = async (code: number): Promise<never> => {
        for (const round of rounds) {
            round.stop();
        }
        autoUpgrade?.stop();
        unproven();
        children?.stopAll();
        for (const held of connections.values()) {
            held.peer.stop();
        }
        // Its supervisor no longer takes them down with it (KillMode=process): this agent's own commands end here.
        await stopRunningCommands();
        await trial.clean();
        await release();
        process.exit(code);
    };
    for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
        process.on(signal, () => void finish(signalExitCode(signal)));
    }
    return { connections, sync: { running: undefined, failures: 0, retryAt: 0 }, kept, children, autoUpgrade, finish };
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
        if (nothingToServe(now) && runtime.sync.running === undefined && !(await stillKeeping(runtime.kept, log))) {
            log("nothing left to serve: agent exiting. Reconnect from a card in your sandbox.");
            await autostart(MACHINE_AUTOSTART, machineLauncher(), log).unregister();
            await runtime.finish(0);
        }
    }
    await stampLinks(runtime.connections);
};

// Claims the environment and settles its supervisor; undefined when another agent holds it or nothing is left to serve.
const begin = async (
    supervised: boolean,
    log: Log,
): Promise<{ readonly served: Served; readonly lease: PidRecord; readonly kept: KeptCheck } | undefined> => {
    const record: PidRecord = { pid: process.pid, build: MACHINE_VERSION };
    if (!(await claim(record, supervised, log))) {
        return undefined;
    }
    const served = await readServed().catch(async (error: unknown) => {
        await release();
        throw error;
    });
    // Asked only of an agent with nothing else to serve, which is the one it decides for; any other has not asked yet.
    const kept: KeptCheck = nothingToServe(served) ? { at: Date.now(), kept: await keptSandboxes() } : { at: Number.NEGATIVE_INFINITY, kept: [] };
    if (nothingToServe(served) && kept.kept.length === 0) {
        // Said once: this runs at every login, and a loop over it would say it every few seconds.
        log("nothing to serve: no sandbox is linked to this device and none is paired for sync. Connect one from a card in your sandbox.");
        await autostart(MACHINE_AUTOSTART, machineLauncher(), log).unregister();
        await release();
        return undefined;
    }
    if (kept.kept.length > 0) {
        log(`no sandbox is linked to this device and none is paired for sync, but ${keptNote(kept.kept)}`);
    }
    const lease: PidRecord = { ...record, supervisor: await assertSupervisor(supervised, log) };
    await holdPidFile(runPidPath, baseDir, lease);
    await sweepBin();
    await takeOverCommandLedger(log);
    return { served, lease, kept };
};

const serving = (served: Served): string =>
    [
        plural(served.links.length, "linked sandbox"),
        plural(served.pairings, "sync pairing"),
        ...(WINDOWS_SIDE ? [plural(served.children.length, "WSL distro")] : []),
    ].join(", ");

// The foreground agent a supervisor runs (systemd, launchd, the logon task, or the Windows side for a distro).
export const runForeground = async (log: Log): Promise<void> => {
    // First of all: an agent whose loop hangs anywhere from here on is killed and restarted by its supervisor, which only
    // ever waits for an exit (watchdog.ts).
    startWatchdog();
    // Read once and cleared, so no process this one starts (a shell, an upgrade) inherits a role that was never its own.
    const supervised = supervisedByWindows();
    delete process.env[SUPERVISOR_ENV];
    delete process.env[UPGRADE_ENV];
    // First, before anything is claimed: this start counts toward the new release's trial, and a third crash in a row
    // puts the previous agent back instead of running this one.
    const trial = await beginTrial(log);
    if (trial === "restored") {
        process.exitCode = EXIT_ROLLED_BACK;
        return;
    }
    const started = await begin(supervised, log);
    if (started === undefined) {
        await trial.clean();
        return;
    }
    const runtime = runtimeOf(supervised, trial, started.kept, started.lease, log);
    log(`serving ${serving(started.served)}`);
    for (;;) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- the tick loop itself, serial by definition
        await tick(runtime, started.lease, log);
        // oxlint-disable-next-line eslint/no-await-in-loop -- ditto
        await sleep(TICK_MS);
    }
};
