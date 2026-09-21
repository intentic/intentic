import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import net from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { errorMessage } from "@intentic/base/errors";
import { plural } from "@intentic/base/format";
import type { Log } from "@intentic/local-agent";
import { type PortSkipReason, type PortSummary, PortsListSchema } from "@intentic/sandbox-contract";
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
import { createDaemonBases, type DaemonBases, type Dialed, dialedPairings } from "../daemon-base.js";
import { realBridgeExec, runGitBridge } from "./git-bridge.js";
import {
    ensureMutagen,
    ensureSyncSession,
    forwardedPorts,
    forwardSessionName,
    healDerivedConflicts,
    mutagenForwardArgs,
    ourForwardSessions,
    pauseUnreachableSync,
    retireOrphanSessions,
    resumeAutoPausedSync,
    runMutagenAsync,
} from "./mutagen.js";
import { quieted } from "./repeats.js";
import { deviceReport, scopedReport } from "./report.js";
import { pairingSshConfig, sshAlias, writeManagedSshConfig } from "./ssh.js";
import { createTunnelPool, tunnelTargets } from "./tunnel.js";

// Mirrors every workspace port in a paired sandbox onto the same port on this machine's localhost, over Mutagen
// TCP forwards on the enrolled SSH transport; a resident watcher polls each daemon's /ports to pick up new servers.
// One watcher serves every pairing off the same re-read pairing list, so adds/revokes take effect next tick.

// How often the watcher re-reads a sandbox's ports; fast enough to catch a fresh dev server quickly.
const POLL_MS = 5000;

// Bounds the ports read; the agent is sequential, so a hang here delays every later pairing too.
const PORTS_TIMEOUT_MS = 10_000;

// How many ticks between repo-list refreshes; the repo set rarely changes, sparing a round trip most ticks.
const REPO_LIST_EVERY_TICKS = 12;

// How often reports go out; slower than POLL_MS since a report costs a `mutagen sync list` per pairing. It rides
// the tick agent rather than its own timer, so it can never outlive a stopped watcher.
const REPORT_EVERY_TICKS = 3;

// A report is small; anything slower than this is a tunnel problem, and the next pass is seconds away.
const REPORT_TIMEOUT_MS = 10_000;

// Consecutive rejected polls before a pairing counts as revoked and gets dropped.
const REVOKED_POLLS = 3;

// Transient failures keep their sessions; only an uninterrupted hour pauses Mutagen's sessions, since otherwise it
// reconnects forever for a deleted sandbox. Resumes automatically on the first healthy response. Measured on the
// clock rather than in polls, because the backoff below is free to stretch what one poll is worth.
const UNREACHABLE_PAUSE_MS = 60 * 60_000;
export const shouldAutoPauseFileSync = (unreachableForMs: number): boolean => unreachableForMs >= UNREACHABLE_PAUSE_MS;

// How long a pairing whose polls keep failing waits for its next one. The read is also the pairing's liveness probe,
// so it never stops; but for a sandbox reached over its public URL each one is a DNS lookup and a TLS handshake
// across the internet, and one dogfooding machine made that call every 13 seconds for 59 hours against a sandbox
// that had ceased to exist. Zero means "poll this tick, like anything healthy".
export const pollBackoffMs = (unreachableForMs: number): number =>
    unreachableForMs < 60_000 ? 0 : unreachableForMs < 10 * 60_000 ? 30_000 : 5 * 60_000;

/** When a pairing's polls started failing and when one was last attempted: the whole memory the backoff needs. */
interface Unreachable {
    readonly since: number;
    readonly lastTried: number;
}

// Whether this tick owes a failing pairing a poll. Pure so the ladder above is a rule with a test rather than a
// comparison buried in the agent.
export const pollDue = (held: Unreachable | undefined, now: number): boolean =>
    held === undefined || now - held.lastTried >= pollBackoffMs(now - held.since);

// The daemon's definitive 401/403 "token not enrolled" answer, distinct from transient failures: revocation drops
// the pairing, a blip retries next tick.
export class SyncAuthError extends Error {}

// Fetches a sandbox's listening workspace ports over its sync token, filtering out system ports and non-forwardable
// binds (e.g. a loopback alias Mutagen can't dial).
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

// Whether the local port is free; called only after terminating this pairing's own prior forward and ruling out
// other pairings, so a conflict is genuinely foreign.
const localPortFree = (port: number): Promise<boolean> =>
    new Promise((resolvePort) => {
        const probe = net.createServer();
        probe.once("error", () => resolvePort(false));
        probe.listen(port, "127.0.0.1", () => probe.close(() => resolvePort(true)));
    });

// The side-effecting operations reconcile drives, injectable so the reconcile logic unit-tests without Mutagen.
export interface ForwardExecutor {
    readonly terminate: (port: number) => void;
    // Must stay async: dialing the sandbox here rides the transport this process itself serves (exec.ts).
    readonly create: (summary: PortSummary) => Promise<void>;
    readonly isLocalPortFree: (port: number) => Promise<boolean>;
}

// The real executor: forward sessions are named per sandbox+port, so reconcile can target them without listing
// and one pairing's teardown can't reach another's. `terminate` stays blocking, a local call to the daemon.
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

// Minimal-touch reconcile: leaves unchanged forwards alone, terminates vanished ports, (re)creates new or
// family-moved ones. `claimedBy` names ports other pairings already hold; first-paired wins a contested port.
// `ignored` is the owner's own standing answer for a number on this device (config.ts `setPortIgnored`), and it is
// checked before everything else: a port nobody may take is not a contest to resolve, so no free-check is spent on it
// and no forward of it survives the switch being thrown.
// The teardown half, split out so each half stays readable: every live forward this pass drops, and the reason it
// says out loud. Ignored leads, since the owner's standing answer outranks whatever else became true of the number.
const retireForwards = (
    executor: ForwardExecutor,
    current: readonly MirroredPort[],
    desiredByPort: ReadonlyMap<number, PortSummary>,
    ignored: ReadonlySet<number>,
    log: Log,
): void => {
    for (const mirrored of current) {
        const match = desiredByPort.get(mirrored.port);
        if (ignored.has(mirrored.port)) {
            executor.terminate(mirrored.port);
            log(`  localhost:${mirrored.port}: stopped (this device is set not to mirror that port)`);
        } else if (match === undefined) {
            executor.terminate(mirrored.port);
            log(`  localhost:${mirrored.port}: stopped (no longer listening in the sandbox)`);
        } else if (match.host !== mirrored.host) {
            executor.terminate(mirrored.port); // family moved: the fresh session below dials the new address
        }
    }
};

export const reconcileForwards = async (
    executor: ForwardExecutor,
    current: readonly MirroredPort[],
    desired: readonly PortSummary[],
    claimedBy: ReadonlyMap<number, string>,
    ignored: ReadonlySet<number>,
    log: Log,
): Promise<MirroredPort[]> => {
    const desiredByPort = new Map(desired.map((port) => [port.port, port]));
    retireForwards(executor, current, desiredByPort, ignored, log);
    const currentByPort = new Map(current.map((mirrored) => [mirrored.port, mirrored]));
    const next: MirroredPort[] = [];
    for (const summary of desired) {
        // First, and before the unchanged-forward shortcut below: a live forward on a newly-ignored port was just
        // terminated above, and keeping it in `next` would make the following pass believe it is still up.
        if (ignored.has(summary.port)) {
            continue;
        }
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
            // A genuinely new port: clears any leftover session from a crashed run before the free-check.
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

// How often the watcher asks Mutagen what it is actually holding. The reconcile above works from the persisted
// baseline, which is right for the ordinary add and remove and blind to a session that baseline lost.
const STRANDED_SWEEP_EVERY_TICKS = 12;

// Forwards Mutagen holds that this pass did not mirror. Kept pure and beside the reconcile because what the gap cost,
// measured on a dogfooding machine, was not one stale port: 30 live forward sessions against a single mirrored one,
// each holding a localhost port and its own SSH connection over the transport this agent itself serves, until new
// connections stopped opening and the git bridge could not run at all — which the watcher then retried every five
// seconds for two days. Terminating the 29 strays fixed it in one pass.
export const strandedForwards = (held: readonly number[], mirrored: readonly MirroredPort[]): number[] => {
    const kept = new Set(mirrored.map((forward) => forward.port));
    return held.filter((port) => !kept.has(port));
};

// The sweep itself. Only ever called with a `mirrored` list a successful reconcile just produced: against a stale
// record this would tear down live forwards.
const sweepStrandedForwards = (mutagen: string, sandboxId: string, mirrored: readonly MirroredPort[], log: Log): void => {
    for (const port of strandedForwards(forwardedPorts(mutagen, sandboxId), mirrored)) {
        spawnSync(mutagen, ["forward", "terminate", forwardSessionName(sandboxId, port)], { stdio: "ignore", windowsHide: true });
        log(`  localhost:${port}: stopped (this device was still holding a forward for it)`);
    }
};

const mirrorKey = (mirrored: MirroredPort): string => `${mirrored.port}:${mirrored.host}`;

const sameMirrorSet = (a: readonly MirroredPort[], b: readonly MirroredPort[]): boolean => {
    if (a.length !== b.length) {
        return false;
    }
    const seen = new Set(a.map(mirrorKey));
    return b.every((mirrored) => seen.has(mirrorKey(mirrored)));
};

// The reason is part of the key: a port going from contended to ignored keeps its number and its holder, and a set
// that could not tell those apart would leave the report saying the old thing until something else moved.
const skippedKey = (skipped: SkippedPort): string => `${skipped.port}:${skipped.reason}:${skipped.heldBy ?? ""}`;

const sameSkippedSet = (a: readonly SkippedPort[], b: readonly SkippedPort[]): boolean => {
    if (a.length !== b.length) {
        return false;
    }
    const seen = new Set(a.map(skippedKey));
    return b.every((skipped) => seen.has(skippedKey(skipped)));
};

// Ports this pairing wanted but didn't get, derived from what reconcile already decided rather than returned
// separately, so reconcileForwards stays a pure port-set function. Persisted so a skip is visible off the log.
// An ignored port is still listed: it is the only row the switch can be thrown back from, and dropping it would make
// a choice somebody made look like a port the sandbox stopped serving.
export const skippedPortsOf = (
    desired: readonly PortSummary[],
    mirrored: readonly MirroredPort[],
    claimedBy: ReadonlyMap<number, string>,
    ignored: ReadonlySet<number>,
): SkippedPort[] => {
    const got = new Set(mirrored.map((port) => port.port));
    return desired
        .filter((summary) => !got.has(summary.port))
        .map((summary): SkippedPort => {
            const heldBy = claimedBy.get(summary.port);
            // Ignored outranks the rest because reconcile never tried: no contest was entered and no bind measured,
            // so the other two reasons are not facts about this pass at all.
            const reason: PortSkipReason = ignored.has(summary.port) ? "ignored" : heldBy === undefined ? "busy" : "held-by-sandbox";
            return { port: summary.port, host: summary.host, reason, heldBy: reason === "held-by-sandbox" ? heldBy : undefined, command: summary.command };
        });
};

// Stamps the end of a pass; a failed write must not stop mirroring, so it silently under-claims.
const beat = async (): Promise<void> => await writeFile(mirrorHeartbeatPath, String(Date.now())).catch(() => {});

// Restart=on-failure never restarts a clean exit; a signal means something else stopped the process, so this
// returns non-zero, or a supervisor won't restart it.
export const signalExitCode = (signal: NodeJS.Signals): number => (signal === "SIGINT" ? 130 : 143);

// Persists one pairing's ports, leaving every other pairing's alone: avoids clobbering a concurrent `setup`'s
// write with this tick's stale read.
const savePorts = async (sandboxId: string, mirroredPorts: readonly MirroredPort[], skippedPorts: readonly SkippedPort[]): Promise<void> =>
    await updateState((state) => ({
        pairings: state.pairings.map((held) => (held.sandboxId === sandboxId ? { ...held, mirroredPorts, skippedPorts } : held)),
    }));

// The whole of a pass for a pairing whose mirroring is off: torn down once, right after the switch flips, so later
// passes find nothing left and cost a length check. Logged in the switch's own words, since reconcile's "no longer
// listening" would misdescribe a sandbox still serving those ports.
const retireSwitchedOff = async (mutagen: string, pairing: Pairing, log: Log): Promise<void> => {
    const mirrored = pairing.mirroredPorts ?? [];
    if (mirrored.length === 0 && (pairing.skippedPorts ?? []).length === 0) {
        return;
    }
    await retirePairingMirror(mutagen, pairing.sandboxId);
    log(`  ${pairing.sandboxId}: port mirroring is off on this device; took ${plural(mirrored.length, "port")} off localhost.`);
};

// One pairing's pass: reconciles its port forwards and returns what it ended up mirroring, so the caller can mark
// those ports claimed for pairings after it. A SyncAuthError propagates for the caller to count.
const servePairing = async (
    mutagen: string,
    pairing: Pairing,
    base: string,
    claimedBy: ReadonlyMap<number, string>,
    log: Log,
): Promise<readonly MirroredPort[]> => {
    const baseline = pairing.mirroredPorts ?? [];
    // Ports are polled even with mirroring off: the read doubles as the pairing's liveness probe and the only way a
    // revoked enrollment is noticed. The switch only changes what's done with the answer.
    const ports = pairing.syncToken === undefined ? [] : await fetchWorkspacePorts(base, pairing.syncToken);
    if (pairing.mirrorOff === true) {
        await retireSwitchedOff(mutagen, pairing, log);
        return [];
    }
    const ignored = new Set(pairing.ignoredPorts ?? []);
    const next = await reconcileForwards(mutagenExecutor(mutagen, pairing, log), baseline, ports, claimedBy, ignored, log);
    const skipped = skippedPortsOf(ports, next, claimedBy, ignored);
    // Either set changing triggers a write, even a port flipping mirrored-to-contended without changing set size.
    if (!sameMirrorSet(baseline, next) || !sameSkippedSet(pairing.skippedPorts ?? [], skipped)) {
        await savePorts(pairing.sandboxId, next, skipped);
    }
    return next;
};

// Reports each pairing's folder/ports/liveness to its own sandbox, scoped per token so none leaks to another.
// Best-effort telemetry: failures are logged and dropped; a definitive 404 retires reporting for that pairing.
const postReports = async (dialed: readonly Dialed<Pairing>[], mutagen: string, unsupported: Set<string>, log: Log): Promise<void> => {
    const reportable = dialed.filter(({ pairing }) => pairing.syncToken !== undefined && !unsupported.has(pairing.sandboxId));
    if (reportable.length === 0) {
        return;
    }
    const report = await deviceReport(mutagen);
    for (const { pairing, base } of reportable) {
        try {
            // oxlint-disable-next-line eslint/no-await-in-loop -- one sandbox at a time, like every other pass in this agent
            const response = await fetch(`${base.replace(/\/$/, "")}/system/sync/report`, {
                method: "POST",
                headers: { "content-type": "application/json", "x-intentic-sync": pairing.syncToken ?? "" },
                body: JSON.stringify(scopedReport(report, pairing.sandboxId)),
                signal: AbortSignal.timeout(REPORT_TIMEOUT_MS),
            });
            // 404 means a daemon predating machine reports; that never heals, so stop asking and say so once.
            if (response.status === 404) {
                unsupported.add(pairing.sandboxId);
                log(`  ${pairing.sandboxId}: this sandbox is running a daemon without machine reports, its Devices view will stay empty.`);
            }
        } catch (error) {
            log(`  ${pairing.sandboxId}: report skipped: ${errorMessage(error)}`);
        }
    }
};

// Forgets a revoked pairing and lets the orphan sweep terminate its file sync and forwards. Its ssh-config block
// is left in place (an unreached alias is inert) until the next setup or uninstall regenerates the fragment.
const dropRevokedPairing = async (mutagen: string, sandboxId: string, log: Log): Promise<void> => {
    await removePairing(sandboxId);
    retireOrphanSessions(mutagen, (await readState()).pairings, log);
};

// Isolates one fallible step: a rejection here costs only this step, not the whole agent, and is always logged.
const guard = async (log: Log, what: string, step: () => void | Promise<void>): Promise<boolean> => {
    try {
        await step();
        return true;
    } catch (error) {
        log(`  ${what} failed: ${errorMessage(error)}`);
        return false;
    }
};

// How often a failed file-sync setup retries; other pairings aren't rechecked every tick.
const SESSION_RETRY_EVERY_TICKS = 60;

// How often the heal reads a pairing's conflicts. Slower than POLL_MS because it costs a `mutagen sync list` per
// pairing and nothing it fixes is urgent: the button on the Devices tab is what answers somebody who is watching, and
// this is what stops them ever having to press it.
const HEAL_EVERY_TICKS = 12;

// The sync half of the resident agent: run by resident.ts, which owns the pidfile, signals and autostart. This
// half must never process.exit() or touch autostart; it just returns when the last pairing is gone.
// One rejected token is a blip; REVOKED_POLLS in a row means the enrollment is gone. Returns whether the pairing
// was dropped, the caller's cue to stop serving it this tick.
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

// Past the pause threshold, an unreachable sandbox's Mutagen sessions are stopped to end permanent reconnect/rescan
// load. Returns whether this pass paused them, so the git bridge below doesn't immediately undo it.
const absorbUnreachablePoll = async (mutagen: string, pairing: Pairing, unreachable: Map<string, Unreachable>, log: Log): Promise<boolean> => {
    const now = Date.now();
    // The first failure of a run sets the clock; every later one only records that a poll was spent, so the hour
    // below is wall-clock and survives the backoff stretching the gaps between them.
    const since = unreachable.get(pairing.sandboxId)?.since ?? now;
    unreachable.set(pairing.sandboxId, { since, lastTried: now });
    if (pairing.fileSyncAutoPaused === true || !shouldAutoPauseFileSync(now - since) || !pauseUnreachableSync(mutagen, pairing)) {
        return false;
    }
    await setFileSyncAutoPaused(pairing.sandboxId, true);
    log(
        `  ${pairing.sandboxId}: unreachable for one hour; paused its Mutagen sessions to stop permanent reconnect/scanning load. They resume automatically when it returns.`,
    );
    return true;
};

/** Per-pairing tallies the failure handler reads and prunes, passed as one bag instead of positional maps. */
interface PairingTracking {
    readonly rejectedPolls: Map<string, number>;
    readonly unreachable: Map<string, Unreachable>;
    readonly repos: Map<string, readonly string[]>;
    readonly sessionsPending: Set<string>;
}

// What a failed pass does to the pairing: `drop` means gone, move to the next one; `paused` means file sync just
// stopped, so the git bridge below must not immediately undo it.
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
    return { drop: false, paused: await absorbUnreachablePoll(mutagen, pairing, tracking.unreachable, log) };
};

// The heal as ONE STEP of a pass, cadence included: the agent below is a list of things done to a pairing, and how often
// this one runs is this step's business rather than another branch in it.
const healPairing = async (mutagen: string, pairing: Pairing, tick: number, log: Log): Promise<void> => {
    if (tick % HEAL_EVERY_TICKS !== 0) {
        return;
    }
    await guard(log, `${pairing.sandboxId}: clearing derived residue`, async () => void (await healDerivedConflicts(mutagen, pairing, log)));
};

// Every pairing's file sync, prepared once at startup: this is where an upgraded agent's inherited sessions pick up
// the new rules, since Mutagen bakes a session's ignores in at creation. Per pairing, so one dead sandbox costs only
// itself; what fails comes back as the pending set and is retried on the cadence below.
const prepareSessions = async (mutagen: string, pairings: readonly Pairing[], say: Log): Promise<Set<string>> => {
    const pending = new Set<string>();
    for (const pairing of pairings) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- one session at a time; the guard is what makes the order safe
        const ready = await guard(say, `${pairing.sandboxId}: preparing its file sync`, async () => await ensureSyncSession(mutagen, pairing, say));
        if (!ready) {
            pending.add(pairing.sandboxId);
        }
    }
    return pending;
};

// The same work on a cadence, for the pairings whose file sync did not come up: asleep, mid-rebuild, or behind a
// transport that was not yet open. The common case is an empty set and no work at all.
const retryPendingSessions = async (
    mutagen: string,
    pairings: readonly Pairing[],
    sessionsPending: Set<string>,
    tick: number,
    say: Log,
): Promise<void> => {
    if (sessionsPending.size === 0 || tick % SESSION_RETRY_EVERY_TICKS !== 0) {
        return;
    }
    for (const pairing of pairings.filter((held) => sessionsPending.has(held.sandboxId))) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- one session at a time, as at startup
        const ready = await guard(say, `${pairing.sandboxId}: preparing its file sync`, async () => await ensureSyncSession(mutagen, pairing, say));
        if (ready) {
            sessionsPending.delete(pairing.sandboxId);
            say(`  ${pairing.sandboxId}: file sync is running again`);
        }
    }
};

/** Everything one pairing's pass needs that is the same for all of them, so the pass itself takes three arguments. */
interface PassContext {
    readonly mutagen: string;
    readonly tick: number;
    // Ports this tick's earlier pairings already took, added to as this one takes its own.
    readonly claimedBy: Map<number, string>;
    readonly tracking: PairingTracking;
    readonly bases: DaemonBases;
    readonly say: Log;
}

// One pairing's whole pass: poll and reconcile its ports, sweep what it strands, heal, bridge. Lifted out of the agent
// so the agent stays a list of what a tick does, rather than one function in which every branch is one pairing's
// business.
const runPairingPass = async (context: PassContext, pairing: Pairing, base: string): Promise<void> => {
    const { mutagen, tick, claimedBy, tracking, bases, say } = context;
    const { rejectedPolls, unreachable, repos, sessionsPending } = tracking;
    let pausedThisPass = false;
    try {
        const mirrored = await servePairing(mutagen, pairing, base, claimedBy, say);
        rejectedPolls.delete(pairing.sandboxId);
        unreachable.delete(pairing.sandboxId);
        if (resumeAutoPausedSync(mutagen, pairing)) {
            await setFileSyncAutoPaused(pairing.sandboxId, false);
            sessionsPending.delete(pairing.sandboxId);
            say(`  ${pairing.sandboxId}: reachable again; resumed its automatically paused file sync`);
        }
        for (const port of mirrored) {
            claimedBy.set(port.port, pairing.sandboxId);
        }
        // Only on a pass that reconciled, and with the list that pass produced: against a stale record this would
        // take down live forwards rather than stranded ones.
        if (tick % STRANDED_SWEEP_EVERY_TICKS === 0) {
            sweepStrandedForwards(mutagen, pairing.sandboxId, mirrored, say);
        }
    } catch (error) {
        // Reports that this pass's resolved base failed, which daemon-base.ts can't detect itself; matters only for a
        // loopback base, so the next tick falls back to the public URL instead of the pairing just failing.
        bases.failed(pairing.sandboxId);
        const outcome = await absorbPairingFailure(error, mutagen, pairing, tracking, say);
        if (outcome.drop) {
            return;
        }
        pausedThisPass = outcome.paused;
        // A transient tunnel blip must not kill the agent, log and try again next tick.
        say(`  ${pairing.sandboxId}: reconcile skipped: ${errorMessage(error)}`);
    }
    // Auto-paused pairings still get the probe above but skip the SSH-heavy git bridge below.
    if (pairing.fileSyncAutoPaused === true || pausedThisPass) {
        return;
    }
    // Before the bridge, and guarded like it: a conflict standing here blocks the very deletions the bridge's
    // fast-forward has already recorded in the local index, so the two disagree until this clears.
    await healPairing(mutagen, pairing, tick, say);
    // The bridge gets its own catch: it rides ssh, while the ports read above rides https (which 502s through
    // Cloudflare often enough), so one must not cost the other a whole pass.
    try {
        const known = tick % REPO_LIST_EVERY_TICKS === 0 ? undefined : repos.get(pairing.sandboxId);
        const listed = await runGitBridge(realBridgeExec, pairing, say, known);
        if (listed === undefined) {
            repos.delete(pairing.sandboxId);
        } else {
            repos.set(pairing.sandboxId, listed);
        }
    } catch (error) {
        say(`  ${pairing.sandboxId}: git bridge skipped: ${errorMessage(error)}`);
    }
};

export const runMirrorWatch = async (log: Log): Promise<void> => {
    const mutagen = await ensureMutagen();
    // Everything below runs every POLL_MS for the life of the machine, so everything below says what it has to say
    // through the quiet rule (repeats.ts) rather than once per tick per pairing.
    const say = quieted(log);
    // Nothing paired is terminal, logged once, not spammed every tick for the life of the session.
    const initial = await readState();
    if (initial.pairings.length === 0) {
        log("no sandboxes are paired: nothing to mirror. Enable it from a sandbox's Desktop sync card.");
        return;
    }
    // This process puts the sandbox's sshd on loopback (tunnel.ts) before any session needs it; reconciled again
    // every tick so a pairing added or dropped mid-run gains or loses its transport without a restart.
    // Regenerated here, not only by setup/uninstall, so an upgraded binary's dialing rules reach an old pairing
    // without a fresh browser token. Idempotent and cheap when already correct.
    await guard(say, "refreshing the ssh configuration", async () => await writeManagedSshConfig(pairingSshConfig(initial.pairings)));
    const tunnels = createTunnelPool(say);
    // Where each pairing's daemon is dialled, held for the watcher's lifetime (daemon-base.ts owns the policy) and
    // cached per sandbox, so most ticks cost only a map lookup.
    const bases = createDaemonBases(say);
    await guard(
        say,
        "opening the sync transports",
        async () => await tunnels.reconcile(tunnelTargets(await dialedPairings(initial.pairings, bases))),
    );
    const sessionsPending = await prepareSessions(mutagen, initial.pairings, say);
    await guard(say, "retiring orphaned sessions", () => retireOrphanSessions(mutagen, initial.pairings, say));
    log(`sync started; polling ${plural(initial.pairings.length, "paired sandbox")} every ${POLL_MS / 1000}s`);

    // Per-pairing state keyed by sandbox id; entries come and go with the pairing.
    const rejectedPolls = new Map<string, number>();
    const unreachable = new Map<string, Unreachable>();
    const repos = new Map<string, readonly string[]>();
    const tracking = { rejectedPolls, unreachable, repos, sessionsPending };
    // Sandboxes with no machine-report route, retired from reporting for this watcher's lifetime.
    const reportUnsupported = new Set<string>();
    for (let tick = 0; ; tick += 1) {
        // Re-read every tick so a concurrent setup/uninstall takes effect without restarting the watcher.
        const state = await readState().catch((error: unknown) => {
            say(`  tick skipped: the sync state didn't read (${errorMessage(error)})`);
            return undefined;
        });
        // Unparseable state (setup caught mid-write): wait and retry rather than spin; heartbeat stays where it was.
        if (state === undefined) {
            await sleep(POLL_MS);
            continue;
        }
        if (state.pairings.length === 0) {
            // Nothing left to sync: stops this half for good rather than polling empty forever. A pairing revoked
            // mid-loop
            // lands here next tick.
            await tunnels.stopAll();
            log("no sandboxes are paired any more: sync stopping. Re-enable from a sandbox's Desktop sync card.");
            return;
        }
        // Where this pass dials each pairing, decided once and shared by the transport reconcile, ports poll, and
        // report
        // below. Cached, so a tick pays for a probe only when the answer could have moved.
        const dialed = await dialedPairings(state.pairings, bases);
        // Runs before the port reconcile and git bridge, both of which ride this transport; a newly added pairing needs
        // its listener up first, and a moved base gets rebound here too.
        await guard(say, "reconciling the sync transports", async () => await tunnels.reconcile(tunnelTargets(dialed)));
        // After the transport reconcile above, which is what a session that failed to create was usually waiting on.
        await retryPendingSessions(mutagen, state.pairings, sessionsPending, tick, say);
        // Ports this tick's earlier pairings already own, so a later one is told who holds a port it wanted.
        const claimedBy = new Map<number, string>();
        for (const { pairing, base } of dialed) {
            // A pairing that has been failing for a while is not polled every tick (pollBackoffMs). The record is kept
            // rather than cleared, so the hour that auto-pauses file sync still runs on wall-clock while it waits.
            if (!pollDue(unreachable.get(pairing.sandboxId), Date.now())) {
                continue;
            }
            // oxlint-disable-next-line eslint/no-await-in-loop -- One sandbox at a time keeps tunnel state ordered.
            await runPairingPass({ mutagen, tick, claimedBy, tracking, bases, say }, pairing, base);
        }
        // Runs after the pairings: servePairing just persisted this tick's ports, and the report re-reads that state,
        // so
        // reporting last reports this tick, not the previous one.
        if (tick % REPORT_EVERY_TICKS === 0) {
            await guard(say, "posting this machine's reports", async () => await postReports(dialed, mutagen, reportUnsupported, say));
        }
        // Stamped at the bottom of the pass that did the work: its whole meaning is that everything above it ran. A
        // tick
        // skipped for unparseable state leaves it where it was.
        await beat();
        await sleep(POLL_MS);
    }
};

// Terminates one pairing's forward sessions (or every one this agent owns with no id given), read from the
// daemon, not a config baseline: Mutagen keeps a forward's listener bound even after its sandbox is gone.
const teardownForwards = async (mutagen: string, sandboxId?: string): Promise<number> => {
    const names = ourForwardSessions(mutagen, sandboxId);
    if (names.length > 0) {
        spawnSync(mutagen, ["forward", "terminate", ...names], { stdio: "ignore", windowsHide: true });
    }
    // A stale baseline would make the next reconcile treat gone forwards as already mirrored. The skip set clears
    // too: mirroring-off isn't the same as losing a contest. `ignoredPorts` survives, being a choice rather than a
    // reading: mirroring switched off and back on must not silently take back a number somebody released.
    await updateState((state) => ({
        pairings: state.pairings.map((held) =>
            sandboxId === undefined || held.sandboxId === sandboxId ? { ...held, mirroredPorts: [], skippedPorts: [] } : held,
        ),
    }));
    return names.length;
};

// Retires one pairing's mirroring; the agent re-reads the pairing list each tick, so others keep running.
export const retirePairingMirror = async (mutagen: string, sandboxId: string): Promise<number> => await teardownForwards(mutagen, sandboxId);

// Takes ONE port off this device's localhost now rather than at the watcher's next pass, and moves its record with
// it: somebody who just asked for a number back should have it before they can alt-tab, and an agent that is stopped
// (or a sandbox that is unreachable) would otherwise keep reporting the port as mirrored for as long as it stayed
// that way. Answers whether anything was actually taken down, which is the difference between "your localhost is
// yours again" and "that port was never on it".
export const retireMirroredPort = async (mutagen: string, sandboxId: string, port: number): Promise<boolean> => {
    spawnSync(mutagen, ["forward", "terminate", forwardSessionName(sandboxId, port)], { stdio: "ignore", windowsHide: true });
    let wasMirrored = false;
    await updateState((state) => ({
        pairings: state.pairings.map((held) => {
            if (held.sandboxId !== sandboxId) {
                return held;
            }
            const mirrored = held.mirroredPorts ?? [];
            const live = mirrored.find((forward) => forward.port === port);
            wasMirrored = live !== undefined;
            // Whichever list held the port carries the same three facts, so one lookup re-files it under its new
            // reason; a port the sandbox isn't serving at all has no row to move and gets none invented for it.
            const record = live ?? (held.skippedPorts ?? []).find((skipped) => skipped.port === port);
            const others = (held.skippedPorts ?? []).filter((skipped) => skipped.port !== port);
            return {
                ...held,
                mirroredPorts: mirrored.filter((forward) => forward.port !== port),
                skippedPorts:
                    record === undefined ? others : [...others, { port, host: record.host, reason: "ignored" as const, command: record.command }],
            };
        }),
    }));
    return wasMirrored;
};

// Tears down every forward this agent owns (full uninstall path). The caller has already stopped the resident
// agent; Mutagen's daemon holds forwards regardless.
export const teardownAllForwards = async (mutagen: string, log: Log): Promise<void> => {
    const forwards = await teardownForwards(mutagen);
    log(forwards === 0 ? "port mirroring stopped." : `port mirroring stopped; tore down ${plural(forwards, "forward")}.`);
};
