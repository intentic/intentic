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
import { createDaemonBases, type Dialed, dialedPairings } from "../daemon-base.js";
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
import { deviceReport, scopedReport } from "./report.js";
import { pairingSshConfig, sshAlias, writeManagedSshConfig } from "./ssh.js";
import { createTunnelPool, tunnelTargets } from "./tunnel.js";

// Mirrors every workspace port in a paired sandbox onto the same port on this machine's localhost, over Mutagen
// TCP forwards on the enrolled SSH transport; a resident watcher polls each daemon's /ports to pick up new servers.
// One watcher serves every pairing off the same re-read pairing list, so adds/revokes take effect next tick.

// How often the watcher re-reads a sandbox's ports; fast enough to catch a fresh dev server quickly.
const POLL_MS = 5000;

// Bounds the ports read; the loop is sequential, so a hang here delays every later pairing too.
const PORTS_TIMEOUT_MS = 10_000;

// How many ticks between repo-list refreshes; the repo set rarely changes, sparing a round trip most ticks.
const REPO_LIST_EVERY_TICKS = 12;

// How often reports go out; slower than POLL_MS since a report costs a `mutagen sync list` per pairing. It rides
// the tick loop rather than its own timer, so it can never outlive a stopped watcher.
const REPORT_EVERY_TICKS = 3;

// A report is small; anything slower than this is a tunnel problem, and the next pass is seconds away.
const REPORT_TIMEOUT_MS = 10_000;

// Consecutive rejected polls before a pairing counts as revoked and gets dropped.
const REVOKED_POLLS = 3;

// Transient failures keep their sessions; only an uninterrupted hour pauses Mutagen's sessions, since otherwise it
// reconnects forever for a deleted sandbox. Resumes automatically on the first healthy response.
const UNREACHABLE_PAUSE_POLLS = Math.ceil((60 * 60_000) / POLL_MS);
export const shouldAutoPauseFileSync = (failedPolls: number): boolean => failedPolls >= UNREACHABLE_PAUSE_POLLS;

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

// Ports this pairing wanted but didn't get, derived from what reconcile already decided rather than returned
// separately, so reconcileForwards stays a pure port-set function. Persisted so a skip is visible off the log.
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
        // Torn down once, right after the switch flips; later passes find nothing left and this costs a length check.
        // Logged in the switch's own words, since reconcile's "no longer listening" would misdescribe a sandbox still
        // serving those ports.
        if (baseline.length > 0 || (pairing.skippedPorts ?? []).length > 0) {
            await retirePairingMirror(mutagen, pairing.sandboxId);
            log(`  ${pairing.sandboxId}: port mirroring is off on this device; took ${baseline.length} port(s) off localhost.`);
        }
        return [];
    }
    const next = await reconcileForwards(mutagenExecutor(mutagen, pairing, log), baseline, ports, claimedBy, log);
    const skipped = skippedPortsOf(ports, next, claimedBy);
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
            // oxlint-disable-next-line eslint/no-await-in-loop -- one sandbox at a time, like every other pass in this loop
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

// Isolates one fallible step: a rejection here costs only this step, not the whole loop, and is always logged.
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

// The sync half of the resident loop: run by resident.ts, which owns the pidfile, signals and autostart. This
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

/** Per-pairing tallies the failure handler reads and prunes, passed as one bag instead of positional maps. */
interface PairingTracking {
    readonly rejectedPolls: Map<string, number>;
    readonly unreachablePolls: Map<string, number>;
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
    return { drop: false, paused: await absorbUnreachablePoll(mutagen, pairing, tracking.unreachablePolls, log) };
};

export const runMirrorWatch = async (log: Log): Promise<void> => {
    const mutagen = await ensureMutagen();
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
    await guard(log, "refreshing the ssh configuration", async () => await writeManagedSshConfig(pairingSshConfig(initial.pairings)));
    const tunnels = createTunnelPool(log);
    // Where each pairing's daemon is dialled, held for the watcher's lifetime (daemon-base.ts owns the policy) and
    // cached per sandbox, so most ticks cost only a map lookup.
    const bases = createDaemonBases(log);
    await guard(
        log,
        "opening the sync transports",
        async () => await tunnels.reconcile(tunnelTargets(await dialedPairings(initial.pairings, bases))),
    );
    // Lets an upgraded agent's inherited file syncs pick up new session rules (Mutagen bakes ignores in at creation).
    // Per pairing, so one dead sandbox costs only itself; failures are retried every SESSION_RETRY_EVERY_TICKS.
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

    // Per-pairing state keyed by sandbox id; entries come and go with the pairing.
    const rejectedPolls = new Map<string, number>();
    const unreachablePolls = new Map<string, number>();
    const repos = new Map<string, readonly string[]>();
    const tracking = { rejectedPolls, unreachablePolls, repos, sessionsPending };
    // Sandboxes with no machine-report route, retired from reporting for this watcher's lifetime.
    const reportUnsupported = new Set<string>();
    for (let tick = 0; ; tick += 1) {
        // Re-read every tick so a concurrent setup/uninstall takes effect without restarting the watcher.
        const state = await readState().catch((error: unknown) => {
            log(`  tick skipped: the sync state didn't read (${errorMessage(error)})`);
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
        await guard(log, "reconciling the sync transports", async () => await tunnels.reconcile(tunnelTargets(dialed)));
        // Retries a pairing whose file sync failed to create (asleep, mid-rebuild, slow transport) now that the
        // transport
        // above was just reconciled. The common case is an empty set.
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
                // Reports that this pass's resolved base failed, which daemon-base.ts can't detect itself; matters only
                // for a
                // loopback base, so the next tick falls back to the public URL instead of the pairing just failing.
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
            // Auto-paused pairings still get the probe above but skip the SSH-heavy git bridge below.
            if (pairing.fileSyncAutoPaused === true || pausedThisPass) {
                continue;
            }
            // The bridge gets its own catch: it rides ssh, while the ports read above rides https (which 502s through
            // Cloudflare often enough), so one must not cost the other a whole pass.
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
        // Runs after the pairings: servePairing just persisted this tick's ports, and the report re-reads that state,
        // so
        // reporting last reports this tick, not the previous one.
        if (tick % REPORT_EVERY_TICKS === 0) {
            await guard(log, "posting this machine's reports", async () => await postReports(dialed, mutagen, reportUnsupported, log));
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
    // too: mirroring-off isn't the same as losing a contest.
    await updateState((state) => ({
        pairings: state.pairings.map((held) =>
            sandboxId === undefined || held.sandboxId === sandboxId ? { ...held, mirroredPorts: [], skippedPorts: [] } : held,
        ),
    }));
    return names.length;
};

// Retires one pairing's mirroring; the loop re-reads the pairing list each tick, so others keep running.
export const retirePairingMirror = async (mutagen: string, sandboxId: string): Promise<number> => await teardownForwards(mutagen, sandboxId);

// Tears down every forward this agent owns (full uninstall path). The caller has already stopped the resident
// loop; Mutagen's daemon holds forwards regardless.
export const teardownAllForwards = async (mutagen: string, log: Log): Promise<void> => {
    const forwards = await teardownForwards(mutagen);
    log(forwards === 0 ? "port mirroring stopped." : `port mirroring stopped; tore down ${forwards} forward(s).`);
};
