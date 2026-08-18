import { spawnSync } from "node:child_process";
import { rm } from "node:fs/promises";
import net from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { type CliLauncher, isProcessAlive, livePid, type Log, spawnDetached, unregisterAutostart, writeSecretFile } from "@intentic/local-agent";
import { type PortSummary, PortsListSchema } from "@intentic/sandbox-contract";
import { MIRROR_AUTOSTART } from "./autostart.js";
import {
    baseDir,
    type MirroredPort,
    mirrorLogPath,
    mirrorPidPath,
    type Pairing,
    readState,
    removePairing,
    type SkippedPort,
    updateState,
} from "./config.js";
import { realBridgeExec, runGitBridge } from "./git-bridge.js";
import {
    ensureMutagen,
    ensureSyncSession,
    forwardSessionName,
    mutagenForwardArgs,
    ourForwardSessions,
    retireOrphanSessions,
    runMutagen,
} from "./mutagen.js";
import { machineReport, scopedReport } from "./report.js";
import { sshAlias } from "./ssh.js";
import { createTunnelPool, tunnelTargets } from "./tunnel.js";

// Port mirroring: every WORKSPACE port listening in a paired sandbox is bound to the SAME port on this machine's
// localhost, over Mutagen TCP forward sessions riding the enrolled SSH transport. This is what makes remote
// development feel local — a frontend baked with `https://localhost:6480` just works (cookies + CORS included)
// because localhost IS serving it. A resident watcher polls each daemon's /ports so a dev server started later
// (Vite grabbing a fresh random port) is mirrored within a poll, with no user action.
//
// ONE watcher serves EVERY pairing. A machine running a fleet of sandboxes has one resident process walking the
// pairing list each tick, not one process per sandbox — the pidfile stays a single-holder lock, and a pairing
// added or revoked is picked up on the next tick because the list is re-read every time.

// How often the watcher re-reads a sandbox's ports. Fast enough that a just-started dev server is reachable
// before the user finishes alt-tabbing to the browser; slow enough to be free.
const POLL_MS = 5000;

// How long to wait on the ports read before abandoning it. Undici's defaults let a hung tunnel — as opposed to
// a tunnel that fails fast — sit on this await for minutes, and the loop is sequential, so everything after it
// waits exactly that long, the git bridge and every LATER pairing included. A tiny JSON over an ssh-grade link
// either answers well inside this or isn't coming.
const PORTS_TIMEOUT_MS = 10_000;

// The git bridge (git-bridge.ts) runs on EVERY tick: no .git file-syncs anymore, so it is the only way a
// sandbox's commits reach the local clones, and file sync delivers a commit's FILES within seconds. Every
// second the bridge lags is therefore a second `git status` here reports the whole landed change as
// uncommitted. A quiet pass now costs one `ls-remote` per repo, cheap enough that the once-a-minute cadence
// this replaces was buying nothing but that lag.
//
// A sandbox's repo SET, though, changes only when a repo is added or removed — so it is cached between passes
// and re-listed only this often, sparing a round trip on every tick in between.
const REPO_LIST_EVERY_TICKS = 12;

/* How often this machine tells each paired sandbox what it looks like from here (report.ts). Slower than the
 * poll because building a report spawns `mutagen sync list` per file-syncing pairing, and the questions it
 * answers — which folder, which ports, is the watcher alive — move in minutes, not seconds. The consequence is
 * stated rather than hidden: the browser's Computers view can lag a just-mirrored port by up to this long, while
 * the port itself is on localhost within one POLL_MS.
 *
 * The report rides the tick loop rather than a timer of its own so it can never outlive the watcher: a report
 * arriving from a process that has stopped mirroring is precisely the stale-but-green lie this whole feature was
 * built to end. */
const REPORT_EVERY_TICKS = 3;

// A report is small and the sandbox stores it in memory; anything slower than this is a tunnel problem, and the
// next pass is seconds away.
const REPORT_TIMEOUT_MS = 10_000;

// How long to wait for a signalled watcher to actually exit, and how often to look. A watcher spends its life
// asleep between polls, so it answers a signal in milliseconds; this bound only covers one wedged in a fetch.
const WATCHER_EXIT_TIMEOUT_MS = 2000;
const WATCHER_EXIT_POLL_MS = 50;

// Consecutive definitive token rejections before the watcher treats ONE pairing's enrollment as revoked
// ("Disable sync" in the browser, or a recreated sandbox that lost the enrollment) and drops it. Revocation never
// heals on its own, so three polls (~15s) is already generous slack against a freak one-off.
const REVOKED_POLLS = 3;

// The daemon's definitive "this token is not enrolled" answer (401/403) — distinct from transient failures so
// the watcher can tell revocation (drop the pairing) from a tunnel blip (retry next tick).
export class SyncAuthError extends Error {}

// A sandbox's currently-listening WORKSPACE ports (dev servers, terminal processes, published containers) —
// what the reconcile drives from. Authenticated by the enrollment-minted sync token, which the daemon scopes
// to exactly this read. System ports (the sandbox's own machinery) are filtered out and never mirrored, and so
// are non-forwardable binds (a loopback alias Mutagen would dial at 127.0.0.1 and never reach).
export const fetchWorkspacePorts = async (sandboxUrl: string, syncToken: string): Promise<PortSummary[]> => {
    const response = await fetch(`${sandboxUrl.replace(/\/$/, "")}/ports`, {
        headers: { "x-intentic-sync": syncToken },
        signal: AbortSignal.timeout(PORTS_TIMEOUT_MS),
    });
    if (response.status === 401 || response.status === 403) {
        throw new SyncAuthError(
            "the sandbox rejected the sync token — click “Enable desktop sync” in your browser and re-run setup to mint a fresh one.",
        );
    }
    if (!response.ok) {
        throw new Error(`reading the sandbox's ports failed (${response.status}): ${await response.text()}`);
    }
    return PortsListSchema.parse(await response.json()).ports.filter((port) => port.kind === "workspace" && port.forwardable);
};

// Whether the local loopback port is free to bind — checked after terminating our OWN prior forward (which held
// it) and after ruling out every other pairing's, so a remaining conflict is genuinely foreign (something else
// on this machine already owns the port).
const localPortFree = (port: number): Promise<boolean> =>
    new Promise((resolvePort) => {
        const probe = net.createServer();
        probe.once("error", () => resolvePort(false));
        probe.listen(port, "127.0.0.1", () => probe.close(() => resolvePort(true)));
    });

// The side-effecting operations reconcile drives, injectable so the reconcile logic unit-tests without Mutagen.
export interface ForwardExecutor {
    readonly terminate: (port: number) => void;
    readonly create: (summary: PortSummary) => void;
    readonly isLocalPortFree: (port: number) => Promise<boolean>;
}

// The real executor: Mutagen forward sessions named per sandbox+port (so reconcile targets them without listing,
// and one pairing's teardown can never reach another's).
const mutagenExecutor = (mutagen: string, pairing: Pairing): ForwardExecutor => ({
    terminate: (port) =>
        void spawnSync(mutagen, ["forward", "terminate", forwardSessionName(pairing.sandboxId, port)], { stdio: "ignore", windowsHide: true }),
    create: (summary) =>
        runMutagen(
            mutagen,
            mutagenForwardArgs({
                name: forwardSessionName(pairing.sandboxId, summary.port),
                port: summary.port,
                alias: sshAlias(pairing.sandboxId),
                host: summary.host,
            }),
        ),
    isLocalPortFree: localPortFree,
});

// Minimal-touch reconcile for ONE pairing: given what it mirrors now (`current`) and what it should (`desired`),
// leave unchanged forwards ALONE (a poll must not drop live connections every tick), terminate ones whose port
// vanished, and (re)create new ports or ones whose sandbox loopback family moved (127.0.0.1 ↔ ::1). Returns the
// new baseline.
//
// `claimedBy` names the ports OTHER pairings are already mirroring this tick. Two sandboxes on one machine
// routinely serve the same dev-server port, and only one of them can own localhost:6480 — so the contest is
// decided here, first-paired wins, and the loser is told WHICH sandbox has it rather than being left to read
// "busy on this machine" and go hunting for a process that doesn't exist.
export const reconcileForwards = async (
    executor: ForwardExecutor,
    current: readonly MirroredPort[],
    desired: readonly PortSummary[],
    claimedBy: ReadonlyMap<number, string>,
    log: Log,
): Promise<MirroredPort[]> => {
    const desiredByPort = new Map(desired.map((port) => [port.port, port]));
    for (const mirrored of current) {
        const match = desiredByPort.get(mirrored.port);
        if (match === undefined) {
            executor.terminate(mirrored.port);
            log(`  localhost:${mirrored.port} — stopped (no longer listening in the sandbox)`);
        } else if (match.host !== mirrored.host) {
            executor.terminate(mirrored.port); // family moved — the fresh session below dials the new address
        }
    }
    const currentByPort = new Map(current.map((mirrored) => [mirrored.port, mirrored]));
    const next: MirroredPort[] = [];
    for (const summary of desired) {
        const existing = currentByPort.get(summary.port);
        if (existing !== undefined && existing.host === summary.host) {
            next.push(existing); // unchanged — the live forward keeps its connections
            continue;
        }
        const heldBy = claimedBy.get(summary.port);
        if (heldBy !== undefined) {
            log(`  localhost:${summary.port} is already mirrored from ${heldBy} — skipped (${summary.command ?? "unknown process"})`);
            continue;
        }
        if (existing === undefined) {
            // A genuinely new port: clear any leftover session of OURS from a crashed run before the free-check.
            executor.terminate(summary.port);
        }
        // oxlint-disable-next-line eslint/no-await-in-loop -- a handful of ports; sequenced keeps the log readable
        if (!(await executor.isLocalPortFree(summary.port))) {
            log(`  localhost:${summary.port} is busy on this machine — skipped (${summary.command ?? "unknown process"})`);
            continue;
        }
        executor.create(summary);
        next.push({ port: summary.port, host: summary.host, command: summary.command });
        log(`  localhost:${summary.port} ← ${summary.command ?? "unknown process"}`);
    }
    return next;
};

const mirrorKey = (mirrored: MirroredPort): string => `${mirrored.port}:${mirrored.host}`;

const sameMirrorSet = (a: readonly MirroredPort[], b: readonly MirroredPort[]): boolean => {
    if (a.length !== b.length) {
        return false;
    }
    const seen = new Set(a.map(mirrorKey));
    return b.every((mirrored) => seen.has(mirrorKey(mirrored)));
};

const skippedKey = (skipped: SkippedPort): string => `${skipped.port}:${skipped.heldBy ?? ""}`;

const sameSkippedSet = (a: readonly SkippedPort[], b: readonly SkippedPort[]): boolean => {
    if (a.length !== b.length) {
        return false;
    }
    const seen = new Set(a.map(skippedKey));
    return b.every((skipped) => seen.has(skippedKey(skipped)));
};

/* The ports this pairing WANTED and did not get, recovered from what the reconcile already decided rather than
 * reported out of it: every desired port either ends up in `mirrored` or hits one of the reconcile's two skip
 * paths, so the difference is exactly the skip set, and `claimedBy` says which of the two it was. Deriving it
 * here keeps reconcileForwards a pure port-set function with one return value.
 *
 * Worth persisting because it is otherwise write-only: the reconcile logs the reason to mirror.log and forgets
 * it, so "my dev server isn't on localhost" has never been answerable anywhere a user can see. */
export const skippedPortsOf = (
    desired: readonly PortSummary[],
    mirrored: readonly MirroredPort[],
    claimedBy: ReadonlyMap<number, string>,
): SkippedPort[] => {
    const got = new Set(mirrored.map((port) => port.port));
    return desired
        .filter((summary) => !got.has(summary.port))
        .map((summary) => ({ port: summary.port, host: summary.host, heldBy: claimedBy.get(summary.port), command: summary.command }));
};

// The pidfile is how `mirror`/`--stop`/`uninstall`/`setup` find the resident watcher across processes.
export const readLiveWatcherPid = async (): Promise<number | undefined> => await livePid(mirrorPidPath);

// On SIGTERM/SIGINT the watcher drops its pidfile and exits, leaving the forwards up (Mutagen's daemon holds
// them) so a restart never breaks live connections.
const watcherShutdown = (): void => void rm(mirrorPidPath, { force: true }).finally(() => process.exit(0));

// Persist one pairing's port picture, leaving every other pairing's alone. Targeted because the watcher and a
// concurrent `setup` write this file for different reasons — a whole-state write from the tick's stale read is
// how the watcher used to stamp an old pairing back over a new one.
const savePorts = async (sandboxId: string, mirroredPorts: readonly MirroredPort[], skippedPorts: readonly SkippedPort[]): Promise<void> =>
    await updateState((state) => ({
        pairings: state.pairings.map((held) => (held.sandboxId === sandboxId ? { ...held, mirroredPorts, skippedPorts } : held)),
    }));

// One pairing's pass: reconcile its port forwards, then run its git bridge. Returns the ports it ended up
// mirroring, so the caller can mark them claimed for the pairings after it. A SyncAuthError propagates — only the
// caller knows how many polls in a row this pairing has been rejected.
const servePairing = async (
    mutagen: string,
    pairing: Pairing,
    claimedBy: ReadonlyMap<number, string>,
    log: Log,
): Promise<readonly MirroredPort[]> => {
    const baseline = pairing.mirroredPorts ?? [];
    const ports = pairing.syncToken === undefined ? [] : await fetchWorkspacePorts(pairing.sandboxUrl, pairing.syncToken);
    const next = await reconcileForwards(mutagenExecutor(mutagen, pairing), baseline, ports, claimedBy, log);
    const skipped = skippedPortsOf(ports, next, claimedBy);
    // Either half changing is a write: a port that flipped from mirrored to contended leaves the mirror set the
    // same size and is exactly the transition the report exists to explain.
    if (!sameMirrorSet(baseline, next) || !sameSkippedSet(pairing.skippedPorts ?? [], skipped)) {
        await savePorts(pairing.sandboxId, next, skipped);
    }
    return next;
};

/* Tell each paired sandbox what this machine looks like from here — the folder it syncs into, the ports it did
 * and did not get onto localhost, and whether the watcher behind them is alive. None of that is knowable from the
 * sandbox side (SYNC_DIR never reaches the daemon), which is why the Desktop sync card could only ever say a
 * machine was enrolled and point at `intentic-sync status` for the rest.
 *
 * Each sandbox is sent its OWN slice (scopedReport) on its OWN token, so this loop can never tell one sandbox
 * about another's folders even though the report it starts from covers the whole machine.
 *
 * BEST-EFFORT, always. Mirroring is the job; reporting is telemetry for a card. A sandbox that is unreachable, or
 * old enough not to have the route, must cost nothing — so failures are logged and dropped, and a definitive
 * "no such route" retires reporting for that pairing rather than knocking on the same door every 15 seconds for
 * the life of the login session. */
const postReports = async (pairings: readonly Pairing[], mutagen: string, unsupported: Set<string>, log: Log): Promise<void> => {
    const reportable = pairings.filter((pairing) => pairing.syncToken !== undefined && !unsupported.has(pairing.sandboxId));
    if (reportable.length === 0) {
        return;
    }
    const report = await machineReport(mutagen);
    for (const pairing of reportable) {
        try {
            // oxlint-disable-next-line eslint/no-await-in-loop -- one sandbox at a time, like every other pass in this loop
            const response = await fetch(`${pairing.sandboxUrl.replace(/\/$/, "")}/system/sync/report`, {
                method: "POST",
                headers: { "content-type": "application/json", "x-intentic-sync": pairing.syncToken ?? "" },
                body: JSON.stringify(scopedReport(report, pairing.sandboxId)),
                signal: AbortSignal.timeout(REPORT_TIMEOUT_MS),
            });
            // 404 = a daemon from before machine reports existed. Nothing about that heals on its own, and the
            // pairing is otherwise perfectly healthy, so stop asking and say so once.
            if (response.status === 404) {
                unsupported.add(pairing.sandboxId);
                log(`  ${pairing.sandboxId}: this sandbox is running a daemon without machine reports — its Computers view will stay empty.`);
            }
        } catch (error) {
            log(`  ${pairing.sandboxId}: report skipped: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
};

// Drop a pairing the sandbox no longer authorizes: forget it, then let the orphan sweep terminate the file-sync
// session and forwards nothing claims any more. Its ssh-config block is deliberately left in place — an alias
// nothing dials is inert, and the fragment is regenerated from the pairing list by the next setup or uninstall,
// which is also where the cloudflared path it needs is resolved.
const dropRevokedPairing = async (mutagen: string, sandboxId: string, log: Log): Promise<void> => {
    await removePairing(sandboxId);
    retireOrphanSessions(mutagen, (await readState()).pairings, log);
};

/* ONE FALLIBLE STEP, ISOLATED — the rule that keeps one broken pairing from taking the watcher with it.
 *
 * Almost everything this loop does can reject: mutagen throws on any non-zero exit (mutagen.ts's runMutagen),
 * the tunnel pool binds sockets, the reports go over the network. There is exactly ONE loop serving EVERY
 * pairing, and an unguarded rejection in it does not crash the process — the tunnel listeners keep the event
 * loop alive on their own. What is left behind is the worst shape a background service can take: a live pid, a
 * `status` that still says "running", a file sync mutagen still reports as "Watching for changes", and a loop
 * that stopped ticking. Nothing tells the user, because the thing that would have told them was the loop.
 *
 * Observed, and the reason this exists: one sandbox whose zone had been retired failed its `mutagen sync create`
 * inside ensureSyncSession during STARTUP — before the tick loop was entered at all. Two perfectly healthy
 * pairings lost their git bridge for a fortnight. The desktop kept syncing files the whole time, so the sandbox
 * committed work the local clone never learned about, and every `git status` there showed the landed changes as
 * uncommitted edits — the "desync" that gets reported as a file-sync bug and never is one.
 *
 * So: every step that can reject is wrapped, and a failure costs its own step and nothing else. Failures are
 * always logged — a watcher running degraded must say so on every pass, because the alternative is this bug
 * again with better manners. */
const guard = async (log: Log, what: string, step: () => void | Promise<void>): Promise<boolean> => {
    try {
        await step();
        return true;
    } catch (error) {
        log(`  ${what} failed: ${error instanceof Error ? error.message : String(error)}`);
        return false;
    }
};

/* How often a pairing whose file sync could NOT be prepared is tried again. Only those: a session that exists
 * and matches costs a `mutagen sync list` to confirm, which is not worth spending every POLL_MS on all of them.
 *
 * This exists because ensureSyncSession runs once, at startup. Guarding it stops one dead sandbox from taking
 * the watcher down, but without a retry the fix trades a dead watcher for a pairing that is dead until the next
 * login — and a sandbox that was merely asleep, or behind a tunnel that took a minute to come up, would need a
 * restart to sync again. Five minutes is far below the session a laptop keeps open and far above the seconds a
 * transport needs to settle. */
const SESSION_RETRY_EVERY_TICKS = 60;

/* The watcher loop — one resident process per machine, serving every pairing. Started detached by
 * `startMirrorWatcher`; also runnable in the foreground (`mirror --watch`) to watch it live, which is what
 * supervisors run too (a systemd user unit, a launchd LaunchAgent).
 *
 * It claims the pidfile before doing anything, and REFUSES if a live watcher already holds it. Only
 * `startMirrorWatcher` used to check, so every path that runs the loop directly would start a second one on top of
 * the first — and two of these do real damage rather than merely wasting a process: both reconcile the same
 * forwards from their own baseline and both write mirroredPorts, so they take turns tearing down and recreating
 * each other's sessions, dropping live connections on a loop. Observed in the field the moment a supervisor
 * started one while a hand-started copy was still resident. */
export const runMirrorWatch = async (log: Log): Promise<void> => {
    const holder = await readLiveWatcherPid();
    if (holder !== undefined && holder !== process.pid) {
        log(`a mirror watcher is already running (pid ${holder}) — leaving it alone. Stop it with \`intentic-sync mirror --stop\` first.`);
        return;
    }
    await writeSecretFile(mirrorPidPath, baseDir, String(process.pid));
    // Stop polling on signal, but leave the forwards up — Mutagen's daemon holds them, so a watcher restart
    // never drops the user's connections. Only `--stop`/`uninstall` tear the forwards down.
    process.on("SIGTERM", watcherShutdown);
    process.on("SIGINT", watcherShutdown);

    const mutagen = await ensureMutagen();
    // Nothing paired: terminal, and said once — the watcher runs at every login, and a loop that treated this as
    // a bad tick would log the same thing every few seconds for the life of the session.
    const initial = await readState();
    if (initial.pairings.length === 0) {
        await unregisterAutostart(MIRROR_AUTOSTART, log);
        await rm(mirrorPidPath, { force: true });
        log("no sandboxes are paired — nothing to mirror. Enable it from a sandbox's Desktop sync card.");
        return;
    }
    /* THE TRANSPORT, BEFORE ANY SESSION — this process is what puts the sandbox's sshd on loopback (tunnel.ts),
     * so Mutagen has nothing to connect to until these listeners are bound. Reconciled again on every tick
     * below, for the same reason the pairing list is re-read: a sandbox paired or dropped while this is running
     * must gain or lose its transport without a restart. */
    const tunnels = createTunnelPool(log);
    await guard(log, "opening the sync transports", async () => await tunnels.reconcile(tunnelTargets(initial.pairings)));
    // The watcher runs at every login, which makes it the one place an upgraded agent reliably reaches the file
    // syncs it INHERITED — Mutagen bakes a session's ignores at creation, so an install that swapped the binary
    // without re-pairing would otherwise keep syncing on whatever rules were current the day it first paired.
    //
    // Per pairing, because a sandbox that has gone away fails here EVERY time and there is nothing to fix from
    // this side: mutagen cannot create a session against an endpoint that will not answer, and it throws saying
    // so. That refusal is about one pairing and must cost one pairing — see `guard`.
    //
    // A pairing that fails here is remembered, not abandoned: the tick loop retries it on SESSION_RETRY_EVERY_TICKS.
    const sessionsPending = new Set<string>();
    for (const pairing of initial.pairings) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- one session at a time, as below; the guard is what makes the order safe
        const ready = await guard(log, `${pairing.sandboxId}: preparing its file sync`, () => ensureSyncSession(mutagen, pairing, log));
        if (!ready) {
            sessionsPending.add(pairing.sandboxId);
        }
    }
    await guard(log, "retiring orphaned sessions", () => retireOrphanSessions(mutagen, initial.pairings, log));
    log(`mirror watcher started (pid ${process.pid}); polling ${initial.pairings.length} paired sandbox(es) every ${POLL_MS / 1000}s`);

    // Per-pairing, keyed by sandbox id: consecutive token rejections, and the cached repo list its git bridge
    // walks. A pairing that comes and goes takes its entries with it.
    const rejectedPolls = new Map<string, number>();
    const repos = new Map<string, readonly string[]>();
    // Sandboxes whose daemon has no machine-report route — retired from reporting for this watcher's lifetime, so
    // an older sandbox costs one request rather than one every REPORT_EVERY_TICKS forever.
    const reportUnsupported = new Set<string>();
    for (let tick = 0; ; tick += 1) {
        // Re-read every tick: this is how a pairing added by a concurrent `setup` starts being served, and how
        // one removed by `uninstall` stops — without restarting the watcher. A state that won't parse (a `setup`
        // mid-write) leaves nothing to do this tick.
        const state = await readState().catch((error: unknown) => {
            log(`  tick skipped: the sync state didn't read (${error instanceof Error ? error.message : String(error)})`);
            return undefined;
        });
        if (state !== undefined) {
            if (state.pairings.length === 0) {
                // Nothing left to serve: stop for good rather than polling an empty list at every login. A
                // pairing that was revoked mid-loop lands here on the next tick.
                await tunnels.stopAll();
                await unregisterAutostart(MIRROR_AUTOSTART, log);
                await rm(mirrorPidPath, { force: true });
                log("no sandboxes are paired any more — watcher exiting. Re-enable from a sandbox's Desktop sync card.");
                return;
            }
            // Before the port reconcile, because that reconcile and the git bridge under it both ride this
            // transport: a pairing added since the last tick needs its listener up before anything asks it to
            // carry an ssh connection.
            await guard(log, "reconciling the sync transports", async () => await tunnels.reconcile(tunnelTargets(state.pairings)));
            // A sandbox whose file sync could not be created — asleep, mid-rebuild, a transport still coming up —
            // gets another go now that its transport has just been reconciled above. Nothing to do in the common
            // case: the set is empty and this costs a subtraction.
            if (sessionsPending.size > 0 && tick % SESSION_RETRY_EVERY_TICKS === 0) {
                for (const pairing of state.pairings.filter((held) => sessionsPending.has(held.sandboxId))) {
                    // oxlint-disable-next-line eslint/no-await-in-loop -- one session at a time, as at startup
                    const ready = await guard(log, `${pairing.sandboxId}: preparing its file sync`, () => ensureSyncSession(mutagen, pairing, log));
                    if (ready) {
                        sessionsPending.delete(pairing.sandboxId);
                        log(`  ${pairing.sandboxId}: file sync is running again`);
                    }
                }
            }
            // Ports this tick's earlier pairings already own, so a later one is told who holds a port it wanted.
            const claimedBy = new Map<number, string>();
            for (const pairing of state.pairings) {
                try {
                    // oxlint-disable-next-line eslint/no-await-in-loop -- one sandbox at a time keeps the log readable and the tunnels unhammered
                    const mirrored = await servePairing(mutagen, pairing, claimedBy, log);
                    rejectedPolls.delete(pairing.sandboxId);
                    for (const port of mirrored) {
                        claimedBy.set(port.port, pairing.sandboxId);
                    }
                } catch (error) {
                    // Revocation is definitive, and it is ONE pairing's: after REVOKED_POLLS consecutive
                    // rejections drop that sandbox and keep serving the rest, instead of polling a dead
                    // enrollment forever (and resurrecting it at every login).
                    if (error instanceof SyncAuthError) {
                        const rejected = (rejectedPolls.get(pairing.sandboxId) ?? 0) + 1;
                        rejectedPolls.set(pairing.sandboxId, rejected);
                        if (rejected >= REVOKED_POLLS) {
                            log(
                                `${pairing.sandboxId} rejected the sync token ${REVOKED_POLLS} polls in a row — this machine's enrollment was revoked.`,
                            );
                            rejectedPolls.delete(pairing.sandboxId);
                            repos.delete(pairing.sandboxId);
                            sessionsPending.delete(pairing.sandboxId);
                            // oxlint-disable-next-line eslint/no-await-in-loop -- teardown of the pairing being abandoned, before the next one is served
                            await dropRevokedPairing(mutagen, pairing.sandboxId, log);
                            continue;
                        }
                    }
                    // A transient tunnel blip must not kill the loop — log and try again next tick.
                    log(`  ${pairing.sandboxId}: reconcile skipped: ${error instanceof Error ? error.message : String(error)}`);
                }
                // The bridge gets its OWN catch. It rides ssh; the ports read above rides https, through
                // Cloudflare, which 502s a sandbox's /ports often enough to matter while the tunnel underneath is
                // perfectly healthy. Sharing one catch meant every such 502 silently cost a whole bridge pass —
                // and because the cadence counted ticks rather than retrying, the next attempt came a full period
                // later, not a tick later, which is what turned a sub-minute lag into the occasional two-minute one.
                try {
                    const known = tick % REPO_LIST_EVERY_TICKS === 0 ? undefined : repos.get(pairing.sandboxId);
                    const listed = runGitBridge(realBridgeExec, pairing, log, known);
                    if (listed === undefined) {
                        repos.delete(pairing.sandboxId);
                    } else {
                        repos.set(pairing.sandboxId, listed);
                    }
                } catch (error) {
                    log(`  ${pairing.sandboxId}: git bridge skipped: ${error instanceof Error ? error.message : String(error)}`);
                }
            }
            // After the pairings, not during: servePairing has just persisted this tick's mirrored/skipped ports,
            // and the report is built by re-reading that state — so reporting last is what makes it report NOW
            // rather than the previous pass.
            if (tick % REPORT_EVERY_TICKS === 0) {
                await guard(log, "posting this machine's reports", async () => await postReports(state.pairings, mutagen, reportUnsupported, log));
            }
        }
        await sleep(POLL_MS);
    }
};

// Start the watcher so it outlives the terminal that launched it, its stdout appended to mirror.log — including
// the Windows console rule that decides which spawn flags it gets (see @intentic/local-agent's detached.ts).
// Idempotent: a live watcher already serves every pairing (it re-reads the list each tick), so a second start is
// a no-op. `launcher` is how to re-invoke this CLI (see cliLauncher).
export const startMirrorWatcher = async (launcher: CliLauncher, log: Log): Promise<void> => {
    const existing = await readLiveWatcherPid();
    if (existing !== undefined) {
        log(`port mirroring is already running (pid ${existing}).`);
        return;
    }
    const pid = await spawnDetached(mirrorLogPath, launcher, MIRROR_AUTOSTART.foregroundArgs);
    log(`mirroring every paired sandbox's workspace ports onto localhost (pid ${pid}). Details: ${mirrorLogPath}`);
};

// Terminate the forward sessions of ONE pairing (or, with no sandbox id, every one this agent owns) — read from
// the DAEMON, not from a config baseline. Mutagen keeps a forward's localhost listener bound even after the
// sandbox behind it is gone (verified against 0.18.1: it still reports ForwardingConnections and still holds the
// port), so a session nobody can name is a port nothing can ever mirror again.
const teardownForwards = async (mutagen: string, sandboxId?: string): Promise<number> => {
    const names = ourForwardSessions(mutagen, sandboxId);
    if (names.length > 0) {
        spawnSync(mutagen, ["forward", "terminate", ...names], { stdio: "ignore", windowsHide: true });
    }
    // A baseline naming forwards that no longer exist would make the next reconcile treat those ports as already
    // mirrored and never recreate them. The skip set goes with it: mirroring being off is not the same fact as a
    // port having lost a contest, and leaving it behind would have the report explaining a state nobody is in.
    await updateState((state) => ({
        pairings: state.pairings.map((held) =>
            sandboxId === undefined || held.sandboxId === sandboxId ? { ...held, mirroredPorts: [], skippedPorts: [] } : held,
        ),
    }));
    return names.length;
};

const stopped = (forwards: number): string =>
    forwards === 0 ? "port mirroring stopped." : `port mirroring stopped; tore down ${forwards} forward(s).`;

// Stop the resident watcher — signalled AND gone, not merely signalled. It re-reads the state every tick and
// writes mirror baselines back into it, and on Windows it holds the agent binary open, so a caller that is about
// to replace either must wait it out. Bounded, because a watcher that won't die is not a reason to fail the
// command that asked for this. The forwards stay up; Mutagen's daemon holds them.
export const stopWatcher = async (): Promise<number | undefined> => {
    const pid = await readLiveWatcherPid();
    if (pid !== undefined) {
        try {
            process.kill(pid, "SIGTERM");
        } catch {
            // already gone between the read and the kill — nothing to stop
        }
        for (let waited = 0; waited < WATCHER_EXIT_TIMEOUT_MS && isProcessAlive(pid); waited += WATCHER_EXIT_POLL_MS) {
            // oxlint-disable-next-line eslint/no-await-in-loop -- a bounded wait for one pid, by definition serial
            await sleep(WATCHER_EXIT_POLL_MS);
        }
    }
    await rm(mirrorPidPath, { force: true });
    return pid;
};

// Retire ONE pairing's mirroring: its forwards go, every other pairing's keep running. The watcher is left alone
// — it re-reads the pairing list each tick, so it simply stops serving what is no longer there.
export const retirePairingMirror = async (mutagen: string, sandboxId: string): Promise<number> => await teardownForwards(mutagen, sandboxId);

// Stop mirroring on this machine entirely (`mirror --stop`, `uninstall --all`) and say what went.
export const stopMirror = async (log: Log): Promise<void> => {
    await stopWatcher();
    log(stopped(await teardownForwards(await ensureMutagen())));
};
