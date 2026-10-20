import { rm } from "node:fs/promises";
import { constants } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { errorMessage } from "@intentic/base/errors";
import { plural } from "@intentic/base/format";
import { autostart, claimPidFile, holdPidFile, type Log, type PidRecord, releasePidFile, stopProcess } from "@intentic/local-agent";
import type { PeerLink } from "@intentic/sandbox-contract/peer-dial";
import { beginTrial, type Trial } from "../agent-trial.js";
import { MACHINE_AUTOSTART } from "../autostart/autostart.js";
import { baseDir, runLogPath, runPidPath } from "../config.js";
import { startAutoBackup } from "../device/sandbox-rounds/auto-backup.js";
import { startAutoPrepare } from "../device/sandbox-rounds/auto-prepare.js";
import { type HostLink, LINK_STAMP_MS, type LinkReading, linkStatePath, readLinks, stampLinkStates } from "../device/config.js";
import { connect, reachedOverLoopback } from "../device/connection.js";
import { hostedSlugs, keeperOn, startKeeper } from "../device/sandbox-rounds/keeper.js";
import { startProbationWatch } from "../device/sandbox-rounds/probation-watch.js";
import { readChannelSlugs } from "../device/sandbox-rounds/swap-records.js";
import { fleet } from "../device/tools/sandboxes.js";
import { takeOverCommandLedger } from "../device/tools/command-ledger.js";
import { stopRunningCommands } from "../device/tools/shell.js";
import { syncEngineEnv } from "../engine-env.js";
import { type Children, superviseChildren } from "../environments/children.js";
import { type AutoUpgrade, startAutoUpgrade } from "../environments/auto-upgrade.js";
import { heldDistros, SUPERVISOR_ENV, supervisedByWindows, updateMachineConfig, withoutChild } from "../environments/machine.js";
import { UPGRADE_ENV } from "../environments/machine-upgrade.js";
import { sweepBin } from "../release.js";
import { assertSupervisor, machineLauncher, readResident, retireResident, startResident } from "./supervision.js";
import { mirrorHeartbeatPath, readState } from "../sync/config.js";
import { pairingSlugs } from "../sync/swap-pause.js";
import { runMirrorWatch } from "../sync/mirror.js";
import { startUpkeep } from "../upkeep/reconcile.js";
import { MACHINE_VERSION } from "../version.js";
import { beginExitRecord, lastExitPath, reasonForCode, recordExit, recordStopFor, recordUnexpectedExits, stampAlive, thisRun } from "./last-exit.js";
import { askHandover, handoverAsked } from "./handover.js";
import { startLogRoll } from "./log-roll.js";
import { startWatchdog, type Watchdog } from "./watchdog.js";
import { WINDOWS_SIDE } from "../environments/wsl.js";
import { startedBeforeSignIn } from "../device/session.js";

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
    `this device runs ${plural(kept.length, "sandbox", "sandboxes")} (${kept.join(", ")}), so the agent stays to bring ${kept.length === 1 ? "it" : "them"} back after a restart; turning the sandbox keeper off lets it go.`;

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

/* BEFORE ANYONE SIGNS IN, AND THE HANDOVER AT A SIGN-IN (2026-10-15). Windows' boot task (`intentic-machine
   before-sign-in on`, local-agent's beforeSignIn) starts this agent with `--before-sign-in` when the PC starts, with no
   session and no desktop, so a PC that Windows Update restarted at night answers before anyone comes to it. It serves
   what needs no desktop: its sandbox links and, on the Windows side, the WSL distros. It leaves alone everything that
   needs a signed-in person: the keeper (which starts Docker Desktop, a program with a window), the sandbox rounds,
   the agent's own updates and file sync. The logon task's agent is the PC's real one: when it starts, at the sign-in,
   it asks this one to leave (a request file this one reads every tick), waits for it to go, and takes the environment
   over, which brings the screen tools back. The boot task's watchdog keeps firing while someone is signed in; each of
   those starts finds an agent running and leaves without a word, so it costs one short-lived process every five
   minutes and nothing in the log. */

// What the boot task's agent stamps as its supervisor, which is how the logon task's agent knows it may take over.
export const BEFORE_SIGN_IN = "before-sign-in";

// How the boot task's agent's exit reads to the agent after it (`Before it:` in describe).
const HANDED_OVER = "handed over at a sign-in to the agent of the signed-in session";

// A supervised distro takes over from whatever copy runs there unsupervised, and the signed-in session's agent from the
// one started before sign-in; anything else leaves a live holder alone. The boot task's agent says nothing when it
// finds one running: it is asked every five minutes while someone is signed in.
const claim = async (record: PidRecord, supervised: boolean, log: Log): Promise<boolean> => {
    if (supervised) {
        await autostart(MACHINE_AUTOSTART, machineLauncher(), log).unregister();
        const holder = await readResident();
        if (holder !== undefined && holder.pid !== process.pid) {
            log(`taking over from the agent already running here (pid ${holder.pid}), since the Windows side keeps this distro's agent running.`);
            await stopProcess(holder.pid, 5_000);
        }
    } else if (record.supervisor !== BEFORE_SIGN_IN) {
        const holder = await readResident();
        if (holder !== undefined && holder.pid !== process.pid && holder.supervisor === BEFORE_SIGN_IN) {
            log(`someone signed in: taking over from the agent this PC started before anyone did (pid ${holder.pid}).`);
            const ended = await askHandover(holder.pid, {
                holderNow: async () => (await readResident())?.pid,
                stop: async (pid) => {
                    recordStopFor(pid, "stopped", "replaced at a sign-in by the agent of the signed-in session");
                    await stopProcess(pid, 5_000);
                },
            });
            if (ended === "stopped") {
                log(`the agent started before sign-in (pid ${holder.pid}) did not leave on its own: it was stopped.`);
            }
        }
    }
    const claimed = await claimPidFile(runPidPath, baseDir, record);
    if (!claimed.claimed && record.supervisor !== BEFORE_SIGN_IN) {
        log(`An agent is already running (pid ${claimed.holder.pid}): leaving it alone. intentic-machine run --stop stops it first.`);
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

// Every link to a sandbox the keeper has just learnt is starting again (woken from sleep, by it or by somebody else) is
// dialled now rather than when its ladder next comes round, which after a long sleep is a quarter of an hour away
// (peer-dial's retryNow, sandbox-rounds/sleep.ts).
export const redialSandbox = (connections: ReadonlyMap<string, Connection>, slug: string): void => {
    for (const [url, held] of connections) {
        if (pairingSlugs(url).includes(slug)) {
            held.peer.retryNow();
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
    // Started by the boot task with nobody signed in (BEFORE ANYONE SIGNS IN, above).
    readonly beforeSignIn: boolean;
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

// The rounds of an agent somebody is signed in for, or that runs where there is no sign-in to wait for (a distro, Linux).
const sessionRounds = (supervised: boolean, connections: ReadonlyMap<string, Connection>, lease: PidRecord, log: Log): { stop: () => void }[] => {
    const watch = startProbationWatch(log, { sweeps: true });
    const keeper = startKeeper(log, {
        links: () => [...connections].map(([url, held]) => ({ url, reading: reading(held.peer) })),
        loopback: reachedOverLoopback,
        watching: watch.running,
        poke: (slug) => redialSandbox(connections, slug),
    });
    const later = supervised ? SUPERVISED_ROUND_DELAY_MS : 0;
    // The device's own upkeep runs everywhere too: each environment holds its own leftovers and stores (upkeep/).
    const upkeep = startUpkeep(log, lease.supervisor);
    return [watch, keeper, startAutoPrepare(log, { delayMs: later }), startAutoBackup(log, { delayMs: later }), upkeep, startLogRoll(runLogPath, log)];
};

const runtimeOf = (supervised: boolean, trial: Trial, kept: KeptCheck, lease: PidRecord, log: Log): Runtime => {
    const beforeSignIn = lease.supervisor === BEFORE_SIGN_IN;
    const connections = new Map<string, Connection>();
    const children = WINDOWS_SIDE
        ? superviseChildren(log, async (distro) => void (await updateMachineConfig((config) => withoutChild(config, distro))))
        : undefined;
    // With nobody signed in, the links and the distros are all this agent serves: every round below either starts a
    // program with a window (the keeper starts Docker Desktop), needs the engine that program runs, or changes this
    // agent itself, and the agent of the signed-in session runs them all from the sign-in on.
    const rounds = beforeSignIn ? [startLogRoll(runLogPath, log)] : sessionRounds(supervised, connections, lease, log);
    const autoUpgrade = supervised || beforeSignIn ? undefined : startAutoUpgrade(log);
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
        const { reason, detail } = reasonForCode(code);
        recordExit(reason, detail);
        process.exit(code);
    };
    for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
        process.on(signal, () => void finish(signalExitCode(signal)));
    }
    return { beforeSignIn, connections, sync: { running: undefined, failures: 0, retryAt: 0 }, kept, children, autoUpgrade, finish };
};

// The lease, and for an agent started before sign-in a sign-in's request to hand over: either ends this agent here.
const keepLease = async (runtime: Runtime, lease: PidRecord, log: Log): Promise<void> => {
    if (runtime.beforeSignIn && (await handoverAsked())) {
        log("someone signed in on this PC: handing this environment over to the agent of their session.");
        recordStopFor(process.pid, "stopped", HANDED_OVER);
        await runtime.finish(0);
    }
    if (!(await holdPidFile(runPidPath, baseDir, lease))) {
        log("another machine agent took this environment over: leaving.");
        if (runtime.beforeSignIn) {
            // Not a failure for the boot task to retry: the signed-in session's agent is the one meant to run now.
            recordStopFor(process.pid, "stopped", HANDED_OVER);
            await runtime.finish(0);
        }
        await runtime.finish(EXIT_REPLACED);
    }
};

// Whether this agent has nothing left to do here: nothing linked, paired or kept, and no sync half still winding down.
// An agent started before sign-in keeps no sandboxes (begin says why), so nothing linked is enough for it.
const doneServing = async (runtime: Runtime, now: Served, log: Log): Promise<boolean> => {
    if (!nothingToServe(now)) {
        return false;
    }
    return runtime.beforeSignIn || (runtime.sync.running === undefined && !(await stillKeeping(runtime.kept, log)));
};

// One pass: the lease first, since everything after it acts on this environment as its one agent.
const tick = async (runtime: Runtime, lease: PidRecord, log: Log): Promise<void> => {
    await keepLease(runtime, lease, log);
    // Every `docker` this round spawns goes to the engine the sandboxes run on now (engine-env.ts).
    syncEngineEnv();
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
        if (!runtime.beforeSignIn) {
            startSyncIfDue(runtime.sync, now.pairings, log);
        }
        if (await doneServing(runtime, now, log)) {
            log("nothing left to serve: agent exiting. Reconnect from a card in your sandbox.");
            // The login entry is the signed-in session's agent to retire, never a session-less one's.
            if (!runtime.beforeSignIn) {
                await autostart(MACHINE_AUTOSTART, machineLauncher(), log).unregister();
            }
            await runtime.finish(0);
        }
    }
    await stampLinks(runtime.connections);
    await stampAlive();
};

// Claims the environment and settles its supervisor; undefined when another agent holds it or nothing is left to serve.
const begin = async (
    supervised: boolean,
    beforeSignIn: boolean,
    log: Log,
): Promise<{ readonly served: Served; readonly lease: PidRecord; readonly kept: KeptCheck } | undefined> => {
    // Stamped from the first write, so a sign-in in the very next second already knows it may take over.
    const record: PidRecord = beforeSignIn
        ? { pid: process.pid, build: MACHINE_VERSION, supervisor: BEFORE_SIGN_IN }
        : { pid: process.pid, build: MACHINE_VERSION };
    if (!(await claim(record, supervised, log))) {
        return undefined;
    }
    const served = await readServed().catch(async (error: unknown) => {
        await release();
        throw error;
    });
    // With nobody signed in there is no engine to ask (Docker Desktop starts with a session), and the sandboxes it would
    // name are the signed-in agent's to keep: a boot agent with nothing linked has nothing to do, and leaves quietly.
    if (beforeSignIn && nothingToServe(served)) {
        await release();
        return undefined;
    }
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
    // The login entry is the signed-in session's to put right: a session-less agent leaves it as it is.
    const lease: PidRecord = { ...record, supervisor: beforeSignIn ? BEFORE_SIGN_IN : await assertSupervisor(supervised, log) };
    await holdPidFile(runPidPath, baseDir, lease);
    await sweepBin();
    await takeOverCommandLedger(log);
    return { served, lease, kept };
};

// This run's exit record, begun once the environment is this agent's (another agent's record is never touched): what the
// agent before it left is said first, and the watchdog is handed the record it closes if it ever has to kill this one.
const beginRecord = async (watchdog: Watchdog, log: Log): Promise<void> => {
    try {
        const before = await beginExitRecord(process.pid, MACHINE_VERSION);
        if (before !== undefined) {
            log(before);
        }
    } catch (error) {
        log(`could not start this run's exit record (${errorMessage(error)}); the next agent will not know why this one ended.`);
        return;
    }
    recordUnexpectedExits();
    const run = thisRun();
    if (run !== undefined) {
        watchdog.record({ path: lastExitPath, base: run });
    }
};

const serving = (served: Served): string =>
    [
        plural(served.links.length, "linked sandbox"),
        plural(served.pairings, "sync pairing"),
        ...(WINDOWS_SIDE ? [plural(served.children.length, "WSL distro")] : []),
    ].join(", ");

// The foreground agent a supervisor runs (systemd, launchd, the logon task, the boot task with `beforeSignIn`, or the
// Windows side for a distro).
export const runForeground = async (log: Log, { beforeSignIn = false }: { readonly beforeSignIn?: boolean } = {}): Promise<void> => {
    if (beforeSignIn) {
        if (!WINDOWS_SIDE) {
            log("--before-sign-in is the start of Windows' boot task; anywhere else the agent's own login entry starts it at boot.");
            return;
        }
        // Before the watchdog and the release's trial: the boot task's watchdog asks every five minutes, signed in or
        // not, and an agent already running is the whole answer. Neither a log line nor a start counted toward a trial.
        if ((await readResident()) !== undefined) {
            return;
        }
        startedBeforeSignIn();
    }
    // First of all: an agent whose loop hangs anywhere from here on is killed and restarted by its supervisor, which only
    // ever waits for an exit (watchdog.ts).
    const watchdog = startWatchdog();
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
    const started = await begin(supervised, beforeSignIn, log);
    if (started === undefined) {
        await trial.clean();
        return;
    }
    await beginRecord(watchdog, log);
    const runtime = runtimeOf(supervised, trial, started.kept, started.lease, log);
    log(`serving ${serving(started.served)}${beforeSignIn ? ", started by this PC before anyone signed in: the screen tools wait for a sign-in" : ""}`);
    for (;;) {
        // the tick loop itself, serial by definition
        await tick(runtime, started.lease, log);
        // ditto
        await sleep(TICK_MS);
    }
};
