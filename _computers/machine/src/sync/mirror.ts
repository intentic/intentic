import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import net from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { errorMessage } from "@intentic/base/errors";
import type { Log } from "@intentic/local-agent";
import { type PortSummary, PortsListSchema } from "@intentic/sandbox-contract";
import {
    mirrorHeartbeatPath,
    type MirroredPort,
    type Pairing,
    readState,
    removePairing,
    setFileSyncAutoPaused,
    type SkippedPort,
    updateState,
} from "./config.js";
import { createDaemonBases, dialedPairings, type DialedPairing } from "./daemon-base.js";
import { realBridgeExec, runGitBridge } from "./git-bridge.js";
import {
    ensureMutagen,
    ensureSyncSession,
    forwardSessionName,
    mutagenForwardArgs,
    ourForwardSessions,
    pauseUnreachableSync,
    retireOrphanSessions,
    resumeAutoPausedSync,
    runMutagenAsync,
} from "./mutagen.js";
import { machineReport, scopedReport } from "./report.js";
import { pairingSshConfig, sshAlias, writeManagedSshConfig } from "./ssh.js";
import { createTunnelPool, tunnelTargets } from "./tunnel.js";

// Port mirroring: every WORKSPACE port listening in a paired sandbox is bound to the SAME port on this machine's
// localhost, over Mutagen TCP forward sessions riding the enrolled SSH transport. This is what makes remote
// development feel local, a frontend baked with `https://localhost:6480` just works (cookies + CORS included)
// because localhost IS serving it. A resident watcher polls each daemon's /ports so a dev server started later
// (Vite grabbing a fresh random port) is mirrored within a poll, with no user action.
//
// ONE watcher serves EVERY pairing. A machine running a fleet of sandboxes has one resident process walking the
// pairing list each tick, not one process per sandbox, the pidfile stays a single-holder lock, and a pairing
// added or revoked is picked up on the next tick because the list is re-read every time.

// How often the watcher re-reads a sandbox's ports. Fast enough that a just-started dev server is reachable
// before the user finishes alt-tabbing to the browser; slow enough to be free.
const POLL_MS = 5000;

// How long to wait on the ports read before abandoning it. Undici's defaults let a hung tunnel, as opposed to
// a tunnel that fails fast, sit on this await for minutes, and the loop is sequential, so everything after it
// waits exactly that long, the git bridge and every LATER pairing included. A tiny JSON over an ssh-grade link
// either answers well inside this or isn't coming.
const PORTS_TIMEOUT_MS = 10_000;

// The git bridge (git-bridge.ts) runs on EVERY tick: no .git file-syncs anymore, so it is the only way a
// sandbox's commits reach the local clones, and file sync delivers a commit's FILES within seconds. Every
// second the bridge lags is therefore a second `git status` here reports the whole landed change as
// uncommitted. A quiet pass now costs one `ls-remote` per repo, cheap enough that the once-a-minute cadence
// this replaces was buying nothing but that lag.
//
// A sandbox's repo SET, though, changes only when a repo is added or removed, so it is cached between passes
// and re-listed only this often, sparing a round trip on every tick in between.
const REPO_LIST_EVERY_TICKS = 12;

/* How often this machine tells each paired sandbox what it looks like from here (report.ts). Slower than the
 * poll because building a report spawns `mutagen sync list` per file-syncing pairing, and the questions it
 * answers, which folder, which ports, is the watcher alive, move in minutes, not seconds. The consequence is
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

// Consecutive definitive token rejections before the watcher treats ONE pairing's enrollment as revoked
// ("Disable sync" in the browser, or a recreated sandbox that lost the enrollment) and drops it. Revocation never
// heals on its own, so three polls (~15s) is already generous slack against a freak one-off.
const REVOKED_POLLS = 3;

// A sleeping/rebuilding sandbox is ordinary, so transient failures retain their sessions. One uninterrupted
// hour is different: Mutagen otherwise keeps two SSH reconnect loops alive forever for a deleted sandbox. Pause
// them, retain the pairing, and resume automatically on the first healthy ports response.
const UNREACHABLE_PAUSE_POLLS = Math.ceil((60 * 60_000) / POLL_MS);
export const shouldAutoPauseFileSync = (failedPolls: number): boolean => failedPolls >= UNREACHABLE_PAUSE_POLLS;

// The daemon's definitive "this token is not enrolled" answer (401/403), distinct from transient failures so
// the watcher can tell revocation (drop the pairing) from a tunnel blip (retry next tick).
export class SyncAuthError extends Error {}

// A sandbox's currently-listening WORKSPACE ports (dev servers, terminal processes, published containers),
// what the reconcile drives from. Authenticated by the enrollment-minted sync token, which the daemon scopes
// to exactly this read. System ports (the sandbox's own machinery) are filtered out and never mirrored, and so
// are non-forwardable binds (a loopback alias Mutagen would dial at 127.0.0.1 and never reach).
//
// `base` is where this pairing's daemon was resolved to this pass (daemon-base.ts), which for a sandbox running
// on this machine is its loopback address rather than its public one. This poll is also what NOTICES a resolved
// loopback base going away: it runs every tick, so a container that stopped costs one failed tick before the
// next resolution demotes the pairing back to its public URL.
export const fetchWorkspacePorts = async (base: string, syncToken: string): Promise<PortSummary[]> => {
    const response = await fetch(`${base.replace(/\/$/, "")}/ports`, {
        headers: { "x-intentic-sync": syncToken },
        signal: AbortSignal.timeout(PORTS_TIMEOUT_MS),
    });
    if (response.status === 401 || response.status === 403) {
        throw new SyncAuthError(
            "the sandbox rejected the sync token: click 'Enable desktop sync' in your browser and re-run setup to mint a fresh one.",
        );
    }
    if (!response.ok) {
        throw new Error(`reading the sandbox's ports failed (${response.status}): ${await response.text()}`);
    }
    return PortsListSchema.parse(await response.json()).ports.filter((port) => port.kind === "workspace" && port.forwardable);
};

// Whether the local loopback port is free to bind, checked after terminating our OWN prior forward (which held
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
    // Async, and it must stay that way here: creating a forward dials the sandbox over the transport THIS process
    // serves, so a blocking create waits on an event loop it is itself holding (exec.ts). Every mirrored port on
    // every machine was failing this way.
    readonly create: (summary: PortSummary) => Promise<void>;
    readonly isLocalPortFree: (port: number) => Promise<boolean>;
}

// The real executor: Mutagen forward sessions named per sandbox+port (so reconcile targets them without listing,
// and one pairing's teardown can never reach another's). `terminate` stays blocking: it is a local call to the
// daemon that dials nothing.
const mutagenExecutor = (mutagen: string, pairing: Pairing, log: Log): ForwardExecutor => ({
    terminate: (port) =>
        void spawnSync(mutagen, ["forward", "terminate", forwardSessionName(pairing.sandboxId, port)], { stdio: "ignore", windowsHide: true }),
    create: async (summary) =>
        await runMutagenAsync(
            mutagen,
            mutagenForwardArgs({
                name: forwardSessionName(pairing.sandboxId, summary.port),
                port: summary.port,
                alias: sshAlias(pairing.sandboxId),
                host: summary.host,
            }),
            log,
        ),
    isLocalPortFree: localPortFree,
});

// Minimal-touch reconcile for ONE pairing: given what it mirrors now (`current`) and what it should (`desired`),
// leave unchanged forwards ALONE (a poll must not drop live connections every tick), terminate ones whose port
// vanished, and (re)create new ports or ones whose sandbox loopback family moved (127.0.0.1 ↔ ::1). Returns the
// new baseline.
//
// `claimedBy` names the ports OTHER pairings are already mirroring this tick. Two sandboxes on one machine
// routinely serve the same dev-server port, and only one of them can own localhost:6480, so the contest is
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
            log(`  localhost:${mirrored.port}: stopped (no longer listening in the sandbox)`);
        } else if (match.host !== mirrored.host) {
            executor.terminate(mirrored.port); // family moved: the fresh session below dials the new address
        }
    }
    const currentByPort = new Map(current.map((mirrored) => [mirrored.port, mirrored]));
    const next: MirroredPort[] = [];
    for (const summary of desired) {
        const existing = currentByPort.get(summary.port);
        if (existing !== undefined && existing.host === summary.host) {
            next.push(existing); // unchanged: the live forward keeps its connections
            continue;
        }
        const heldBy = claimedBy.get(summary.port);
        if (heldBy !== undefined) {
            log(`  localhost:${summary.port} is already mirrored from ${heldBy}: skipped (${summary.command ?? "unknown process"})`);
            continue;
        }
        if (existing === undefined) {
            // A genuinely new port: clear any leftover session of OURS from a crashed run before the free-check.
            executor.terminate(summary.port);
        }
        // oxlint-disable-next-line eslint/no-await-in-loop -- a handful of ports; sequenced keeps the log readable
        if (!(await executor.isLocalPortFree(summary.port))) {
            log(`  localhost:${summary.port} is busy on this machine: skipped (${summary.command ?? "unknown process"})`);
            continue;
        }
        // oxlint-disable-next-line eslint/no-await-in-loop -- a handful of ports, and each create dials the
        // sandbox over this process's own transport; sequencing keeps the log readable
        await executor.create(summary);
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

/* The end of a whole pass, stamped where every reader can see it (config.ts explains why the pid alone is not
 * this fact). Best-effort by construction: a watcher that cannot write its own stamp must keep mirroring, the
 * cost of a failed write is a status line that under-claims, which is the safe direction for a liveness signal. */
const beat = async (): Promise<void> => await writeFile(mirrorHeartbeatPath, String(Date.now())).catch(() => {});

/* ON A SIGNAL THE RESIDENT LOOP EXITS 128+SIGNAL, NOT 0, and that number is the whole difference between "sync
 * came back" and "sync was silently off for a day". A signal is not the process deciding to stop, it is
 * something else deciding for it, and the supervisor is the only party that can tell WHICH something: systemd
 * never restarts a unit whose stop it initiated, whatever the exit code, so `systemctl --user stop`,
 * `disable --now` and the `unregisterAutostart` every teardown path runs first all still stay stopped.
 * Everything ELSE that delivers a SIGTERM (a WSL session torn down under the distro, a logind session ending, a
 * stray `pkill`) is exactly the case that must come back, and under `Restart=on-failure` an exit of 0 told
 * systemd it was a clean stop and it never did.
 *
 * Observed, and the reason for the rule: this machine's watcher took a SIGTERM it never asked for, exited 0,
 * and stayed down for five hours with `Connected: No` on both endpoints. Nothing restarted it and nothing said
 * so, because the thing that would have said so was the loop. The exits the loop CHOOSES: nothing to serve any
 * more, and another loop already holding the pidfile, still return normally and so still exit 0, which is what
 * keeps a refusing loop from being restarted into refusing again every RestartSec.
 *
 * Defined here, used by resident.ts, which owns the signal handlers: the sync half earned this rule and carries
 * its story, the shared loop is what enforces it. */
export const signalExitCode = (signal: NodeJS.Signals): number => (signal === "SIGINT" ? 130 : 143);

// Persist one pairing's port picture, leaving every other pairing's alone. Targeted because the watcher and a
// concurrent `setup` write this file for different reasons, a whole-state write from the tick's stale read is
// how the watcher used to stamp an old pairing back over a new one.
const savePorts = async (sandboxId: string, mirroredPorts: readonly MirroredPort[], skippedPorts: readonly SkippedPort[]): Promise<void> =>
    await updateState((state) => ({
        pairings: state.pairings.map((held) => (held.sandboxId === sandboxId ? { ...held, mirroredPorts, skippedPorts } : held)),
    }));

// One pairing's pass: reconcile its port forwards, then run its git bridge. Returns the ports it ended up
// mirroring, so the caller can mark them claimed for the pairings after it. A SyncAuthError propagates, only the
// caller knows how many polls in a row this pairing has been rejected.
const servePairing = async (
    mutagen: string,
    pairing: Pairing,
    base: string,
    claimedBy: ReadonlyMap<number, string>,
    log: Log,
): Promise<readonly MirroredPort[]> => {
    const baseline = pairing.mirroredPorts ?? [];
    /* THE POLL HAPPENS EVEN WITH MIRRORING OFF, and it is worth saying why the switch is not simply a `continue`
     * further up: this read is also the pairing's liveness probe (the sandbox stamps its enrollment's heartbeat
     * on it, platform/sync.ts) and the only thing that ever notices a revoked enrollment. A machine that stopped
     * polling would go quiet on the Desktop sync card and keep a dead pairing forever. What the switch changes is
     * what is DONE with the answer. */
    const ports = pairing.syncToken === undefined ? [] : await fetchWorkspacePorts(base, pairing.syncToken);
    if (pairing.mirrorOff === true) {
        /* Torn down ONCE, on the first pass after the switch was thrown: `sync mirror off` tears down for itself,
         * so the ordinary path finds nothing left and this costs a length check. Said in the words of the switch
         * rather than through the reconcile below, whose "no longer listening in the sandbox" would be a lie
         * about a sandbox that is serving those ports perfectly well. */
        if (baseline.length > 0 || (pairing.skippedPorts ?? []).length > 0) {
            await retirePairingMirror(mutagen, pairing.sandboxId);
            log(`  ${pairing.sandboxId}: port mirroring is off on this computer; took ${baseline.length} port(s) off localhost.`);
        }
        return [];
    }
    const next = await reconcileForwards(mutagenExecutor(mutagen, pairing, log), baseline, ports, claimedBy, log);
    const skipped = skippedPortsOf(ports, next, claimedBy);
    // Either half changing is a write: a port that flipped from mirrored to contended leaves the mirror set the
    // same size and is exactly the transition the report exists to explain.
    if (!sameMirrorSet(baseline, next) || !sameSkippedSet(pairing.skippedPorts ?? [], skipped)) {
        await savePorts(pairing.sandboxId, next, skipped);
    }
    return next;
};

/* Tell each paired sandbox what this machine looks like from here, the folder it syncs into, the ports it did
 * and did not get onto localhost, and whether the watcher behind them is alive. None of that is knowable from the
 * sandbox side (SYNC_DIR never reaches the daemon), which is why the Desktop sync card could only ever say a
 * machine was enrolled and point at `intentic-machine status` for the rest.
 *
 * Each sandbox is sent its OWN slice (scopedReport) on its OWN token, so this loop can never tell one sandbox
 * about another's folders even though the report it starts from covers the whole machine.
 *
 * BEST-EFFORT, always. Mirroring is the job; reporting is telemetry for a card. A sandbox that is unreachable, or
 * old enough not to have the route, must cost nothing, so failures are logged and dropped, and a definitive
 * "no such route" retires reporting for that pairing rather than knocking on the same door every 15 seconds for
 * the life of the login session. */
const postReports = async (dialed: readonly DialedPairing[], mutagen: string, unsupported: Set<string>, log: Log): Promise<void> => {
    const reportable = dialed.filter(({ pairing }) => pairing.syncToken !== undefined && !unsupported.has(pairing.sandboxId));
    if (reportable.length === 0) {
        return;
    }
    const report = await machineReport(mutagen);
    for (const { pairing, base } of reportable) {
        try {
            // oxlint-disable-next-line eslint/no-await-in-loop -- one sandbox at a time, like every other pass in this loop
            const response = await fetch(`${base.replace(/\/$/, "")}/system/sync/report`, {
                method: "POST",
                headers: { "content-type": "application/json", "x-intentic-sync": pairing.syncToken ?? "" },
                body: JSON.stringify(scopedReport(report, pairing.sandboxId)),
                signal: AbortSignal.timeout(REPORT_TIMEOUT_MS),
            });
            // 404 = a daemon from before machine reports existed. Nothing about that heals on its own, and the
            // pairing is otherwise perfectly healthy, so stop asking and say so once.
            if (response.status === 404) {
                unsupported.add(pairing.sandboxId);
                log(`  ${pairing.sandboxId}: this sandbox is running a daemon without machine reports, its Computers view will stay empty.`);
            }
        } catch (error) {
            log(`  ${pairing.sandboxId}: report skipped: ${errorMessage(error)}`);
        }
    }
};

// Drop a pairing the sandbox no longer authorizes: forget it, then let the orphan sweep terminate the file-sync
// session and forwards nothing claims any more. Its ssh-config block is deliberately left in place, an alias
// nothing dials is inert, and the fragment is regenerated from the pairing list by the next setup or uninstall,
// which is also where the cloudflared path it needs is resolved.
const dropRevokedPairing = async (mutagen: string, sandboxId: string, log: Log): Promise<void> => {
    await removePairing(sandboxId);
    retireOrphanSessions(mutagen, (await readState()).pairings, log);
};

/* ONE FALLIBLE STEP, ISOLATED, the rule that keeps one broken pairing from taking the watcher with it.
 *
 * Almost everything this loop does can reject: mutagen throws on any non-zero exit (mutagen.ts's runMutagen),
 * the tunnel pool binds sockets, the reports go over the network. There is exactly ONE loop serving EVERY
 * pairing, and an unguarded rejection in it does not crash the process, the tunnel listeners keep the event
 * loop alive on their own. What is left behind is the worst shape a background service can take: a live pid, a
 * `status` that still says "running", a file sync mutagen still reports as "Watching for changes", and a loop
 * that stopped ticking. Nothing tells the user, because the thing that would have told them was the loop.
 *
 * Observed, and the reason this exists: one sandbox whose zone had been retired failed its `mutagen sync create`
 * inside ensureSyncSession during STARTUP, before the tick loop was entered at all. Two perfectly healthy
 * pairings lost their git bridge for a fortnight. The desktop kept syncing files the whole time, so the sandbox
 * committed work the local clone never learned about, and every `git status` there showed the landed changes as
 * uncommitted edits, the "desync" that gets reported as a file-sync bug and never is one.
 *
 * So: every step that can reject is wrapped, and a failure costs its own step and nothing else. Failures are
 * always logged, a watcher running degraded must say so on every pass, because the alternative is this bug
 * again with better manners. */
const guard = async (log: Log, what: string, step: () => void | Promise<void>): Promise<boolean> => {
    try {
        await step();
        return true;
    } catch (error) {
        log(`  ${what} failed: ${errorMessage(error)}`);
        return false;
    }
};

/* How often a pairing whose file sync could NOT be prepared is tried again. Only those: a session that exists
 * and matches costs a `mutagen sync list` to confirm, which is not worth spending every POLL_MS on all of them.
 *
 * This exists because ensureSyncSession runs once, at startup. Guarding it stops one dead sandbox from taking
 * the watcher down, but without a retry the fix trades a dead watcher for a pairing that is dead until the next
 * login, and a sandbox that was merely asleep, or behind a tunnel that took a minute to come up, would need a
 * restart to sync again. Five minutes is far below the session a laptop keeps open and far above the seconds a
 * transport needs to settle. */
const SESSION_RETRY_EVERY_TICKS = 60;

/* The sync half of the resident loop, serving every pairing. Run by resident.ts, which owns the pidfile, the
 * signal handlers and the login autostart entry for the WHOLE agent — this function must therefore never
 * process.exit() and never touch the autostart: it RETURNS when the last pairing is gone, and what that means
 * for the process (exit, or keep serving the computer half's links) is the caller's decision, made with facts
 * this half cannot see. */
/* Revocation is definitive, and it is ONE pairing's: one rejected sync token is a blip, REVOKED_POLLS in a row
 * is an enrollment this machine no longer has. Counting them here rather than acting on the first is what stops
 * a dead pairing being polled forever and resurrected at every login. Answers whether the pairing was dropped,
 * which is the caller's cue to stop serving it this tick. */
const absorbRejectedPoll = async (
    mutagen: string,
    pairing: Pairing,
    rejectedPolls: Map<string, number>,
    repos: Map<string, readonly string[]>,
    sessionsPending: Set<string>,
    log: Log,
): Promise<boolean> => {
    const rejected = (rejectedPolls.get(pairing.sandboxId) ?? 0) + 1;
    rejectedPolls.set(pairing.sandboxId, rejected);
    if (rejected < REVOKED_POLLS) {
        return false;
    }
    log(`${pairing.sandboxId} rejected the sync token ${REVOKED_POLLS} polls in a row: this machine's enrollment was revoked.`);
    rejectedPolls.delete(pairing.sandboxId);
    repos.delete(pairing.sandboxId);
    sessionsPending.delete(pairing.sandboxId);
    await dropRevokedPairing(mutagen, pairing.sandboxId, log);
    return true;
};

/* An unreachable sandbox, counted the same way: past the pause threshold its Mutagen sessions are stopped, so a
 * tunnel that is not coming back stops costing permanent reconnect and rescan load. Answers whether THIS pass is
 * what paused them, which is what keeps the git bridge below from immediately undoing the pause. */
const absorbUnreachablePoll = async (mutagen: string, pairing: Pairing, unreachablePolls: Map<string, number>, log: Log): Promise<boolean> => {
    const failed = (unreachablePolls.get(pairing.sandboxId) ?? 0) + 1;
    unreachablePolls.set(pairing.sandboxId, failed);
    if (pairing.fileSyncAutoPaused === true || !shouldAutoPauseFileSync(failed) || !pauseUnreachableSync(mutagen, pairing)) {
        return false;
    }
    await setFileSyncAutoPaused(pairing.sandboxId, true);
    log(
        `  ${pairing.sandboxId}: unreachable for one hour; paused its Mutagen sessions to stop permanent reconnect/scanning load. They resume automatically when it returns.`,
    );
    return true;
};

/** The four per-pairing tallies the failure handler reads and prunes, passed as one bag rather than five
 *  positional maps. */
interface PairingTracking {
    readonly rejectedPolls: Map<string, number>;
    readonly unreachablePolls: Map<string, number>;
    readonly repos: Map<string, readonly string[]>;
    readonly sessionsPending: Set<string>;
}

/* What a failed pass does to the pairing that failed, in one answer the loop can act on: `drop` means it is
 * gone and this tick should move to the next one, `paused` means its file sync was just stopped and the
 * ssh-heavy git bridge below must not immediately undo that. */
const absorbPairingFailure = async (
    error: unknown,
    mutagen: string,
    pairing: Pairing,
    tracking: PairingTracking,
    log: Log,
): Promise<{ readonly drop: boolean; readonly paused: boolean }> => {
    if (error instanceof SyncAuthError) {
        const drop = await absorbRejectedPoll(mutagen, pairing, tracking.rejectedPolls, tracking.repos, tracking.sessionsPending, log);
        return { drop, paused: false };
    }
    return { drop: false, paused: await absorbUnreachablePoll(mutagen, pairing, tracking.unreachablePolls, log) };
};

export const runMirrorWatch = async (log: Log): Promise<void> => {
    const mutagen = await ensureMutagen();
    // Nothing paired: terminal, and said once, the loop runs at every login, and one that treated this as a bad
    // tick would log the same thing every few seconds for the life of the session.
    const initial = await readState();
    if (initial.pairings.length === 0) {
        log("no sandboxes are paired: nothing to mirror. Enable it from a sandbox's Desktop sync card.");
        return;
    }
    /* THE TRANSPORT, BEFORE ANY SESSION, this process is what puts the sandbox's sshd on loopback (tunnel.ts),
     * so Mutagen has nothing to connect to until these listeners are bound. Reconciled again on every tick
     * below, for the same reason the pairing list is re-read: a sandbox paired or dropped while this is running
     * must gain or lose its transport without a restart. */
    /* THE SSH FRAGMENT, REGENERATED HERE, because otherwise only `setup` and `uninstall` would ever write it,
     * and that would make it the one piece of this agent's state an upgrade cannot reach. A machine paired
     * months ago would keep dialling on whatever rules were current the day it was paired, no matter how many
     * times the binary was replaced, and the only cure would be to go back to the browser for a fresh pairing
     * token.
     *
     * Same argument as ensureSyncSession: the watcher runs at every login, so it is where an inherited
     * configuration is brought onto this build's rules. The write is idempotent and derived from the pairing
     * list, so a machine that is already correct pays one file comparison. */
    await guard(log, "refreshing the ssh configuration", async () => await writeManagedSshConfig(pairingSshConfig(initial.pairings)));
    const tunnels = createTunnelPool(log);
    /* WHERE EACH PAIRING'S DAEMON IS DIALLED, held for this watcher's lifetime (daemon-base.ts owns the policy).
     * The verdict is per sandbox and cached, so asking on every tick costs a map lookup and only a pairing whose
     * answer could have changed pays for a probe. */
    const bases = createDaemonBases(log);
    await guard(
        log,
        "opening the sync transports",
        async () => await tunnels.reconcile(tunnelTargets(await dialedPairings(initial.pairings, bases))),
    );
    // The watcher runs at every login, which makes it the one place an upgraded agent reliably reaches the file
    // syncs it INHERITED. Mutagen bakes a session's ignores at creation, so an install that swapped the binary
    // without re-pairing would otherwise keep syncing on whatever rules were current the day it first paired.
    //
    // Per pairing, because a sandbox that has gone away fails here EVERY time and there is nothing to fix from
    // this side: mutagen cannot create a session against an endpoint that will not answer, and it throws saying
    // so. That refusal is about one pairing and must cost one pairing, see `guard`.
    //
    // A pairing that fails here is remembered, not abandoned: the tick loop retries it on SESSION_RETRY_EVERY_TICKS.
    const sessionsPending = new Set<string>();
    for (const pairing of initial.pairings) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- one session at a time, as below; the guard is what makes the order safe
        const ready = await guard(log, `${pairing.sandboxId}: preparing its file sync`, async () => await ensureSyncSession(mutagen, pairing, log));
        if (!ready) {
            sessionsPending.add(pairing.sandboxId);
        }
    }
    await guard(log, "retiring orphaned sessions", () => retireOrphanSessions(mutagen, initial.pairings, log));
    log(`sync started; polling ${initial.pairings.length} paired sandbox(es) every ${POLL_MS / 1000}s`);

    // Per-pairing, keyed by sandbox id: consecutive token rejections, and the cached repo list its git bridge
    // walks. A pairing that comes and goes takes its entries with it.
    const rejectedPolls = new Map<string, number>();
    const unreachablePolls = new Map<string, number>();
    const repos = new Map<string, readonly string[]>();
    const tracking = { rejectedPolls, unreachablePolls, repos, sessionsPending };
    // Sandboxes whose daemon has no machine-report route, retired from reporting for this watcher's lifetime, so
    // an older sandbox costs one request rather than one every REPORT_EVERY_TICKS forever.
    const reportUnsupported = new Set<string>();
    for (let tick = 0; ; tick += 1) {
        // Re-read every tick: this is how a pairing added by a concurrent `setup` starts being served, and how
        // one removed by `uninstall` stops, without restarting the watcher. A state that won't parse (a `setup`
        // mid-write) leaves nothing to do this tick.
        const state = await readState().catch((error: unknown) => {
            log(`  tick skipped: the sync state didn't read (${errorMessage(error)})`);
            return undefined;
        });
        // Nothing parsed this tick — a `setup` caught mid-write. Wait out the interval and try again rather
        // than spinning, and leave the heartbeat where it was: a watcher that cannot read its own pairings is
        // not serving them, and going quiet until it can is what a reader should see.
        if (state === undefined) {
            await sleep(POLL_MS);
            continue;
        }
        if (state.pairings.length === 0) {
            // Nothing left to sync: stop this half for good rather than polling an empty list at every
            // login. A pairing that was revoked mid-loop lands here on the next tick. The caller decides
            // what the process does about it.
            await tunnels.stopAll();
            log("no sandboxes are paired any more: sync stopping. Re-enable from a sandbox's Desktop sync card.");
            return;
        }
        /* WHERE THIS PASS DIALS EACH PAIRING, decided once, up front, and shared by all three things that
         * dial it: the transport below, the ports poll, and the report at the bottom. Re-asked every tick so a
         * container started after this watcher gets promoted onto loopback without a restart, and so one that
         * went away is demoted instead of failing the pairing — but asked through the cache, so the tick pays
         * for a probe only when the answer could have moved, never per tick. */
        const dialed = await dialedPairings(state.pairings, bases);
        // Before the port reconcile, because that reconcile and the git bridge under it both ride this
        // transport: a pairing added since the last tick needs its listener up before anything asks it to
        // carry an ssh connection. A pairing whose base moved since the last tick is rebound here too.
        await guard(log, "reconciling the sync transports", async () => await tunnels.reconcile(tunnelTargets(dialed)));
        // A sandbox whose file sync could not be created, asleep, mid-rebuild, a transport still coming up,
        // gets another go now that its transport has just been reconciled above. Nothing to do in the common
        // case: the set is empty and this costs a subtraction.
        if (sessionsPending.size > 0 && tick % SESSION_RETRY_EVERY_TICKS === 0) {
            for (const pairing of state.pairings.filter((held) => sessionsPending.has(held.sandboxId))) {
                // oxlint-disable-next-line eslint/no-await-in-loop -- one session at a time, as at startup
                const ready = await guard(
                    log,
                    `${pairing.sandboxId}: preparing its file sync`,
                    async () => await ensureSyncSession(mutagen, pairing, log),
                );
                if (ready) {
                    sessionsPending.delete(pairing.sandboxId);
                    log(`  ${pairing.sandboxId}: file sync is running again`);
                }
            }
        }
        // Ports this tick's earlier pairings already own, so a later one is told who holds a port it wanted.
        const claimedBy = new Map<number, string>();
        for (const { pairing, base } of dialed) {
            let pausedThisPass = false;
            try {
                // oxlint-disable-next-line eslint/no-await-in-loop -- one sandbox at a time keeps the log readable and the tunnels unhammered
                const mirrored = await servePairing(mutagen, pairing, base, claimedBy, log);
                rejectedPolls.delete(pairing.sandboxId);
                unreachablePolls.delete(pairing.sandboxId);
                if (resumeAutoPausedSync(mutagen, pairing)) {
                    // oxlint-disable-next-line eslint/no-await-in-loop -- targeted state mutation for the pairing that just recovered
                    await setFileSyncAutoPaused(pairing.sandboxId, false);
                    sessionsPending.delete(pairing.sandboxId);
                    log(`  ${pairing.sandboxId}: reachable again; resumed its automatically paused file sync`);
                }
                for (const port of mirrored) {
                    claimedBy.set(port.port, pairing.sandboxId);
                }
            } catch (error) {
                /* THE BASE THIS PASS USED JUST LET US DOWN, which is the one report daemon-base.ts cannot make
                 * for itself: it resolves an address, and only the caller finds out whether the address kept
                 * working. It matters for a LOOPBACK base and nothing else — a container that stopped, or was
                 * recreated onto a different port, would otherwise keep this pairing pointed at a dead port for
                 * the life of the login. Saying so here drops that verdict, and the next tick's resolution
                 * falls back to the public URL instead of the pairing simply failing. */
                bases.failed(pairing.sandboxId);
                // oxlint-disable-next-line eslint/no-await-in-loop -- one pairing's failure is absorbed before the next is served
                const outcome = await absorbPairingFailure(error, mutagen, pairing, tracking, log);
                if (outcome.drop) {
                    continue;
                }
                pausedThisPass = outcome.paused;
                // A transient tunnel blip must not kill the loop, log and try again next tick.
                log(`  ${pairing.sandboxId}: reconcile skipped: ${errorMessage(error)}`);
            }
            // An auto-paused pairing still gets the cheap HTTPS liveness probe above; do not immediately
            // defeat the pause with the SSH-heavy git bridge below.
            if (pairing.fileSyncAutoPaused === true || pausedThisPass) {
                continue;
            }
            // The bridge gets its OWN catch. It rides ssh; the ports read above rides https, through
            // Cloudflare, which 502s a sandbox's /ports often enough to matter while the tunnel underneath is
            // perfectly healthy. Sharing one catch meant every such 502 silently cost a whole bridge pass,
            // and because the cadence counted ticks rather than retrying, the next attempt came a full period
            // later, not a tick later, which is what turned a sub-minute lag into the occasional two-minute one.
            try {
                const known = tick % REPO_LIST_EVERY_TICKS === 0 ? undefined : repos.get(pairing.sandboxId);
                // oxlint-disable-next-line eslint/no-await-in-loop -- one pairing's bridge at a time, as above
                const listed = await runGitBridge(realBridgeExec, pairing, log, known);
                if (listed === undefined) {
                    repos.delete(pairing.sandboxId);
                } else {
                    repos.set(pairing.sandboxId, listed);
                }
            } catch (error) {
                log(`  ${pairing.sandboxId}: git bridge skipped: ${errorMessage(error)}`);
            }
        }
        // After the pairings, not during: servePairing has just persisted this tick's mirrored/skipped ports,
        // and the report is built by re-reading that state, so reporting last is what makes it report NOW
        // rather than the previous pass.
        if (tick % REPORT_EVERY_TICKS === 0) {
            await guard(log, "posting this machine's reports", async () => await postReports(dialed, mutagen, reportUnsupported, log));
        }
        /* HERE, at the bottom of the pass, and INSIDE the branch that did the work: the stamp's whole meaning
         * is that everything above it ran. A tick skipped because the state would not parse leaves the stamp
         * where it was, a watcher that cannot read its own pairings is not serving them, and going quiet
         * until it can is exactly what a reader should see. */
        await beat();
        await sleep(POLL_MS);
    }
};

// Terminate the forward sessions of ONE pairing (or, with no sandbox id, every one this agent owns), read from
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

// Retire ONE pairing's mirroring: its forwards go, every other pairing's keep running. The loop is left alone
// — it re-reads the pairing list each tick, so it simply stops serving what is no longer there.
export const retirePairingMirror = async (mutagen: string, sandboxId: string): Promise<number> => await teardownForwards(mutagen, sandboxId);

// Tear down every forward this agent owns (the full uninstall path) and say what went. The caller has already
// stopped the resident loop; the forwards outlive it either way, Mutagen's daemon holds them.
export const teardownAllForwards = async (mutagen: string, log: Log): Promise<void> => {
    const forwards = await teardownForwards(mutagen);
    log(forwards === 0 ? "port mirroring stopped." : `port mirroring stopped; tore down ${forwards} forward(s).`);
};
