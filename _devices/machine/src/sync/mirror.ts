import { spawnSync } from "node:child_process";
import net from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { errorMessage } from "@intentic/base/errors";
import { plural } from "@intentic/base/format";
import { writeFileAtomic } from "@intentic/base/fs";
import type { Log } from "@intentic/local-agent";
import { type DeviceReport, type PortSkipReason, type PortSummary, PortsListSchema } from "@intentic/sandbox-contract";
import {
    isAttachedPairing,
    mirrorHeartbeatPath,
    type MirroredPort,
    type Pairing,
    pairingKey,
    pairingTransport,
    readState,
    removeSandboxPairings,
    setFileSyncAutoPaused,
    setFileSyncSwapPaused,
    setSandboxGone,
    setUnreachableSince,
    type SkippedPort,
    updateState,
} from "./config.js";
import { pairingEndpoint } from "./endpoint.js";
import { candidateBases, createDaemonBases, type DaemonBases, type Dialed, dialedPairings } from "../daemon-base.js";
import { answeredGone, goneStep, SandboxGoneError } from "./gone.js";
import { checkContainers, checkKeptHere, type FateSeams, sandboxAnswered, sandboxSaidGone } from "./gone-watch.js";
import { retireSandbox } from "./retire.js";
import { readSwapRecords } from "../device/sandbox-rounds/swap-records.js";
import { type PublishedPorts, publishedPortsReader } from "./docker-ports.js";
import { realBridgeExec, runGitBridge } from "./git-bridge.js";
import {
    ensureMutagen,
    ensureSyncSession,
    existingSyncSessions,
    forwardedPorts,
    forwardSessionName,
    healDerivedConflicts,
    MUTAGEN_CALL_TIMEOUT_MS,
    mutagenForwardArgs,
    ourForwardSessions,
    pauseRunningSync,
    pauseUnreachableSync,
    type RelabelBudget,
    relabelBudget,
    retireOrphanSessions,
    resumeAutoPausedSync,
    resumeSwapPausedSync,
    runMutagenAsync,
    sayDaemonEventsTo,
    sessionLabels,
    syncMode,
    syncSessionNames,
} from "./mutagen.js";
import { quieted } from "./repeats.js";
import { deviceReport, scopedReport } from "./report.js";
import { pairingSshConfig, writeManagedSshConfig } from "./ssh.js";
import { holdsSync, recordOf, RELEASE_FORWARDS_MS, shouldReleaseForwards, swapPauseStep } from "./swap-pause.js";
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
    // The edge's own verdict, read on every answer that is not OK (gone.ts): a sandbox the platform no longer has is
    // not an outage to wait out.
    if (answeredGone(response)) {
        throw new SandboxGoneError(`the platform says this sandbox no longer exists (${response.status}): ${await response.text()}`);
    }
    if (!response.ok) {
        throw new Error(`reading the sandbox's ports failed (${response.status}): ${await response.text()}`);
    }
    return PortsListSchema.parse(await response.json()).ports.filter((port) => port.kind === "workspace" && port.forwardable);
};

// Whether the local port is free; called only after terminating this pairing's own prior forward and ruling out
// other pairings, so a conflict is genuinely foreign. One instant's answer: a holder in the middle of a restart reads
// as free, which is what `LocalHolds` is for.
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
        void spawnSync(mutagen, ["forward", "terminate", forwardSessionName(pairing.sandboxId, port)], {
            stdio: "ignore",
            windowsHide: true,
            timeout: MUTAGEN_CALL_TIMEOUT_MS,
        }),
    create: async (summary) =>
        await runMutagenAsync(
            mutagen,
            mutagenForwardArgs({
                name: forwardSessionName(pairing.sandboxId, summary.port),
                port: summary.port,
                remote: pairingEndpoint(pairing),
                host: summary.host,
                labels: sessionLabels(pairing.sandboxId, "forward"),
            }),
            log,
        ),
    isLocalPortFree: localPortFree,
});

// How long a port this machine was seen holding has to stay free before it is mirrored: well past the minutes Docker
// Desktop takes to restart and bring its containers back, the window in which the bind probe finds a held port free.
export const BUSY_GRACE_MS = 15 * 60_000;

/** What a pass knows of this machine's own holders of a port, beyond the bind probe's one instant. */
export interface LocalHolds {
    // Host ports this machine's Docker engine publishes, with the containers publishing them (for the log line only);
    // undefined when Docker could not be asked, which leaves the grace below to hold the line alone.
    readonly docker: PublishedPorts | undefined;
    // The ports the last pass that listed them found busy: the pairing's persisted skip set, so an agent restarted
    // while their holder was down still knows. One of these is mirrored only once it has stayed free for BUSY_GRACE_MS.
    readonly wasBusy: ReadonlySet<number>;
    // When this process first saw each of those free (and unpublished) again. Kept by reconcile, in memory only: a
    // restarted agent starts the grace over, which is the cautious way round.
    readonly freeSince: Map<number, number>;
    readonly now: number;
}

// The teardown half, split out so each half stays readable: every live forward this pass drops, and the reason it
// says out loud. Ignored leads, since the owner's standing answer outranks whatever else became true of the number.
const retireForwards = (
    executor: ForwardExecutor,
    current: readonly MirroredPort[],
    desiredByPort: ReadonlyMap<number, PortSummary>,
    ignored: ReadonlySet<number>,
    docker: PublishedPorts | undefined,
    log: Log,
): void => {
    for (const mirrored of current) {
        const match = desiredByPort.get(mirrored.port);
        const publishers = docker?.get(mirrored.port);
        if (ignored.has(mirrored.port)) {
            executor.terminate(mirrored.port);
            log(`  localhost:${mirrored.port}: stopped (this device is set not to mirror that port)`);
        } else if (publishers !== undefined) {
            // What a forward taken while Docker restarted leaves behind: the container's own publish failed, Docker never
            // retries it, and whatever dials the port reaches the sandbox instead.
            executor.terminate(mirrored.port);
            log(`  localhost:${mirrored.port}: stopped (a Docker container on this machine publishes that port: ${publishers})`);
        } else if (match === undefined) {
            executor.terminate(mirrored.port);
            log(`  localhost:${mirrored.port}: stopped (no longer listening in the sandbox)`);
        } else if (match.host !== mirrored.host) {
            executor.terminate(mirrored.port); // family moved: the fresh session below dials the new address
        }
    }
};

// Whether a port none of this device's mirroring holds may be forwarded now: free to bind this instant and, if the last
// pass found it busy, free ever since this process first saw it so, for the whole grace. Says why not.
const mayTake = async (executor: ForwardExecutor, summary: PortSummary, holds: LocalHolds, log: Log): Promise<boolean> => {
    const listening = summary.command ?? "unknown process";
    if (!(await executor.isLocalPortFree(summary.port))) {
        holds.freeSince.delete(summary.port);
        log(`  localhost:${summary.port} is busy on this machine: skipped (${listening})`);
        return false;
    }
    if (!holds.wasBusy.has(summary.port)) {
        return true;
    }
    const since = holds.freeSince.get(summary.port) ?? holds.now;
    holds.freeSince.set(summary.port, since);
    if (holds.now - since >= BUSY_GRACE_MS) {
        return true;
    }
    log(
        `  localhost:${summary.port} was busy on this machine until recently: holding off until it has stayed free for ${BUSY_GRACE_MS / 60_000} minutes (${listening})`,
    );
    return false;
};

// Minimal-touch reconcile: leaves unchanged forwards alone, terminates vanished ports, (re)creates new or
// family-moved ones. `claimedBy` names ports other pairings already hold; first-paired wins a contested port.
// `ignored` is the owner's own standing answer for a number on this device (config.ts `setPortIgnored`), and it is
// checked before everything else: a port nobody may take is not a contest to resolve, so no free-check is spent on it
// and no forward of it survives the switch being thrown. A port this machine's Docker publishes comes next, on the same
// terms. `holds` is what the bind probe cannot see: a holder that is down for a moment, Docker's or any other.
export const reconcileForwards = async (
    executor: ForwardExecutor,
    current: readonly MirroredPort[],
    desired: readonly PortSummary[],
    claimedBy: ReadonlyMap<number, string>,
    ignored: ReadonlySet<number>,
    holds: LocalHolds,
    log: Log,
): Promise<MirroredPort[]> => {
    const desiredByPort = new Map(desired.map((port) => [port.port, port]));
    retireForwards(executor, current, desiredByPort, ignored, holds.docker, log);
    const currentByPort = new Map(current.map((mirrored) => [mirrored.port, mirrored]));
    const next: MirroredPort[] = [];
    for (const summary of desired) {
        // First, and before the unchanged-forward shortcut below: a live forward on a newly-ignored port was just
        // terminated above, and keeping it in `next` would make the following pass believe it is still up.
        if (ignored.has(summary.port)) {
            continue;
        }
        // The same for a port Docker publishes, and it counts as busy: the grace starts over once Docker lets it go.
        const publishers = holds.docker?.get(summary.port);
        if (publishers !== undefined) {
            holds.freeSince.delete(summary.port);
            log(
                `  localhost:${summary.port} is published by a Docker container on this machine (${publishers}): skipped (${summary.command ?? "unknown process"})`,
            );
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
        if (!(await mayTake(executor, summary, holds, log))) {
            continue;
        }
        // oxlint-disable-next-line eslint/no-await-in-loop -- a handful of ports, and each create dials the
        // sandbox over this process's own transport; sequencing keeps the log readable
        await executor.create(summary);
        // Only once the forward exists: a create that failed leaves the grace served, so the next pass tries at once.
        holds.freeSince.delete(summary.port);
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
    // A listing that did not answer is not "nothing held": nothing is swept on it.
    const held = forwardedPorts(mutagen, sandboxId);
    for (const port of held === undefined ? [] : strandedForwards(held, mirrored)) {
        spawnSync(mutagen, ["forward", "terminate", forwardSessionName(sandboxId, port)], {
            stdio: "ignore",
            windowsHide: true,
            timeout: MUTAGEN_CALL_TIMEOUT_MS,
        });
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
// a choice somebody made look like a port the sandbox stopped serving. "busy" covers every holder on this machine: a
// bind now, a Docker publish, a grace still being served. It is also the next pass's memory (`busyLastPass`), and no
// new reason is minted for the other two, since a daemon or an editor older than it would refuse the whole report.
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
            return {
                port: summary.port,
                host: summary.host,
                reason,
                heldBy: reason === "held-by-sandbox" ? heldBy : undefined,
                command: summary.command,
            };
        });
};

// Whose forward each port is, off every pairing's record as a tick begins. A pairing's forwards bind their ports until
// its own pass says otherwise, so a pairing listed before it finds them bound: named here, such a port is filed as held
// by that sandbox rather than as busy, which would make it wait out the grace once that sandbox let it go.
export const recordedForwards = (pairings: readonly Pick<Pairing, "sandboxId" | "mirroredPorts">[]): Map<number, string> =>
    new Map(pairings.flatMap((held) => (held.mirroredPorts ?? []).map((port) => [port.port, held.sandboxId] as const)));

// One finished pass's word on its own forwards, in place of its record's. A pass that failed says nothing: its forwards
// are still up, and its record still speaks for them.
export const handOver = (holding: Map<number, string>, sandboxId: string, mirrored: readonly MirroredPort[]): void => {
    for (const [port, holder] of holding) {
        if (holder === sandboxId) {
            holding.delete(port);
        }
    }
    for (const port of mirrored) {
        holding.set(port.port, sandboxId);
    }
};

// The forwards one pairing's skips are named off: every pairing's but its own.
export const othersHolding = (holding: ReadonlyMap<number, string>, sandboxId: string): ReadonlyMap<number, string> =>
    new Map([...holding].filter(([, holder]) => holder !== sandboxId));

// Stamps the end of a pass; a failed write must not stop mirroring, so it silently under-claims.
const beat = async (): Promise<void> => await writeFileAtomic(mirrorHeartbeatPath, String(Date.now())).catch(() => {});

// Persists one pairing's ports, leaving every other pairing's alone: avoids clobbering a concurrent `setup`'s
// write with this tick's stale read.
const savePorts = async (key: string, mirroredPorts: readonly MirroredPort[], skippedPorts: readonly SkippedPort[]): Promise<void> =>
    await updateState((state) => ({
        pairings: state.pairings.map((held) => (pairingKey(held) === key ? { ...held, mirroredPorts, skippedPorts } : held)),
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

// The ports this pairing's last pass found busy, read off its persisted skip set: what an agent restarted while their
// holder was down still knows of them. Only that reason counts, so a port somebody stopped ignoring, or one a sibling
// sandbox held, is taken as soon as it is free, as before.
export const busyLastPass = (pairing: Pick<Pairing, "skippedPorts">): ReadonlySet<number> =>
    new Set((pairing.skippedPorts ?? []).filter((skipped) => skipped.reason === "busy").map((skipped) => skipped.port));

/** What the watcher keeps across passes about this machine's own holders of a port. */
interface HolderMemory {
    // Docker's answer, asked at most every DOCKER_ANSWER_MS and never throwing (docker-ports.ts).
    readonly dockerPorts: () => Promise<PublishedPorts | undefined>;
    // Per pairing, when each port its last pass found busy was first seen free again (`LocalHolds.freeSince`).
    readonly freeSince: Map<string, Map<number, number>>;
}

const holdsFor = async (memory: HolderMemory, pairing: Pairing): Promise<LocalHolds> => {
    const freeSince = memory.freeSince.get(pairing.sandboxId) ?? new Map<number, number>();
    memory.freeSince.set(pairing.sandboxId, freeSince);
    return { docker: await memory.dockerPorts(), wasBusy: busyLastPass(pairing), freeSince, now: Date.now() };
};

// One pairing's pass: reconciles its port forwards and returns what it ended up mirroring, so the caller can mark
// those ports claimed for pairings after it. A SyncAuthError propagates for the caller to count.
const servePairing = async (context: PassContext, pairing: Pairing, base: string): Promise<readonly MirroredPort[]> => {
    const { mutagen, claimedBy, holding, holders, say: log } = context;
    const baseline = pairing.mirroredPorts ?? [];
    // Ports are polled even with mirroring off: the read doubles as the pairing's liveness probe and the only way a
    // revoked enrollment is noticed. The switch only changes what's done with the answer.
    const ports = pairing.syncToken === undefined ? [] : await fetchWorkspacePorts(base, pairing.syncToken);
    // A folder attached to its sandbox polls only when nothing else of that sandbox does (`pollingPairings`), as its
    // liveness probe; the projects host is what mirrors the sandbox's ports, once, whatever number of folders it holds.
    if (isAttachedPairing(pairing)) {
        return [];
    }
    if (pairing.mirrorOff === true) {
        await retireSwitchedOff(mutagen, pairing, log);
        return [];
    }
    const ignored = new Set(pairing.ignoredPorts ?? []);
    const holds = await holdsFor(holders, pairing);
    const next = await reconcileForwards(mutagenExecutor(mutagen, pairing, log), baseline, ports, claimedBy, ignored, holds, log);
    // Named off every sibling's forwards, not only those of the pairings this tick has passed (`recordedForwards`).
    const skipped = skippedPortsOf(ports, next, othersHolding(holding, pairing.sandboxId), ignored);
    // Either set changing triggers a write, even a port flipping mirrored-to-contended without changing set size.
    if (!sameMirrorSet(baseline, next) || !sameSkippedSet(pairing.skippedPorts ?? [], skipped)) {
        await savePorts(pairingKey(pairing), next, skipped);
    }
    return next;
};

// One report per sandbox, carried by the first of its pairings that holds a token (they share one): several pairings
// of one sandbox (its projects host and the folders attached to it) are one machine to its daemon, which keeps one
// report per machine, so posting each would only send the same slice again.
// (2026-10-05) Never to a sandbox said to be gone: a dead sandbox took 5,760 report posts a day, none of them logged.
export const reportCarriers = <T extends { readonly pairing: Pick<Pairing, "sandboxId" | "syncToken" | "goneSince"> }>(
    dialed: readonly T[],
    unsupported: ReadonlySet<string>,
): T[] => {
    const seen = new Set<string>();
    return dialed.filter(({ pairing }) => {
        if (pairing.syncToken === undefined || pairing.goneSince !== undefined || unsupported.has(pairing.sandboxId) || seen.has(pairing.sandboxId)) {
            return false;
        }
        seen.add(pairing.sandboxId);
        return true;
    });
};

// One sandbox's slice of the report, posted to it over the pairing's token.
const sendReport = async (base: string, pairing: Pick<Pairing, "sandboxId" | "syncToken">, report: DeviceReport): Promise<Response> =>
    await fetch(`${base.replace(/\/$/, "")}/system/sync/report`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-intentic-sync": pairing.syncToken ?? "" },
        body: JSON.stringify(scopedReport(report, pairing.sandboxId)),
        signal: AbortSignal.timeout(REPORT_TIMEOUT_MS),
    });

// Reports each sandbox's folders/ports/liveness to that sandbox, scoped per sandbox so none leaks to another.
// Best-effort telemetry: failures are logged (quietly, repeats.ts) and dropped; a definitive 404 retires reporting for
// that sandbox, and the edge's "no such sandbox" marks it gone (`gone`).
const postReports = async (
    dialed: readonly Dialed<Pairing>[],
    mutagen: string,
    unsupported: Set<string>,
    gone: (pairing: Pairing) => Promise<void>,
    log: Log,
): Promise<void> => {
    const reportable = reportCarriers(dialed, unsupported);
    if (reportable.length === 0) {
        return;
    }
    const report = await deviceReport(mutagen);
    for (const { pairing, base } of reportable) {
        try {
            // oxlint-disable-next-line eslint/no-await-in-loop -- one sandbox at a time, like every other pass in this agent
            const response = await sendReport(base, pairing, report);
            // 404 means a daemon predating machine reports; that never heals, so stop asking and say so once.
            if (response.status === 404) {
                unsupported.add(pairing.sandboxId);
                log(`  ${pairing.sandboxId}: this sandbox is running a daemon without machine reports, its Devices view will stay empty.`);
            } else if (answeredGone(response)) {
                // oxlint-disable-next-line eslint/no-await-in-loop -- ditto
                await gone(pairing);
            } else if (!response.ok) {
                log(`  ${pairing.sandboxId}: report not taken (${response.status})`);
            }
        } catch (error) {
            log(`  ${pairing.sandboxId}: report skipped: ${errorMessage(error)}`);
        }
    }
};

// Forgets a revoked sandbox's pairings, every one of them since they share its one enrollment (the projects host and
// the folders attached to it), and lets the orphan sweep terminate their file sync and forwards. Its ssh-config block
// is left in place (an unreached alias is inert) until the next setup or uninstall regenerates the fragment.
const dropRevokedPairing = async (mutagen: string, sandboxId: string, log: Log): Promise<void> => {
    await removeSandboxPairings(sandboxId);
    retireOrphanSessions(mutagen, (await readState()).pairings, log);
};

// Whether a pairing key is one of this sandbox's: its own id, or a folder attached to it.
const keyOfSandbox = (key: string, sandboxId: string): boolean => key === sandboxId || key.startsWith(`${sandboxId}~`);

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

// How often file sync that has not reached this build's rules tries again; other pairings aren't rechecked every tick.
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
    for (const key of [...sessionsPending].filter((held) => keyOfSandbox(held, pairing.sandboxId))) {
        sessionsPending.delete(key);
    }
    await dropRevokedPairing(mutagen, pairing.sandboxId, log);
    return true;
};

// Past the pause threshold, an unreachable sandbox's Mutagen sessions are stopped to end permanent reconnect/rescan
// load. Returns whether this pass paused them, so the git bridge below doesn't immediately undo it. Before that, at ten
// minutes, its forwarded ports come off localhost (swap-pause.ts): the reconcile of its first answer puts them back.
const absorbUnreachablePoll = async (mutagen: string, pairing: Pairing, unreachable: Map<string, Unreachable>, log: Log): Promise<boolean> => {
    const now = Date.now();
    // The first failure of a run sets the clock; every later one only records that a poll was spent, so the hour
    // below is wall-clock and survives the backoff stretching the gaps between them. (2026-10-05) The clock is kept on
    // disk too (`unreachableSince`), written once per outage: kept in memory alone, an agent restarted more often than
    // hourly started the hour over each time and never paused a dead sandbox's sessions.
    const since = unreachable.get(pairing.sandboxId)?.since ?? pairing.unreachableSince ?? now;
    unreachable.set(pairing.sandboxId, { since, lastTried: now });
    if (pairing.unreachableSince === undefined) {
        await setUnreachableSince(pairing.sandboxId, since);
    }
    const mirrored = (pairing.mirroredPorts ?? []).length;
    if (shouldReleaseForwards(now - since, mirrored)) {
        await retirePairingMirror(mutagen, pairing.sandboxId);
        log(
            `  ${pairing.sandboxId}: unreachable for ${RELEASE_FORWARDS_MS / 60_000} minutes; took its ${plural(mirrored, "port")} off localhost. They come back when it answers again.`,
        );
    }
    return await pauseIfLongUnreachable(mutagen, pairing, now - since, log);
};

// Past an hour unreachable, a pairing's own sessions are paused (and the pause recorded as the watcher's, so it lifts
// it): the sandbox's poll above says so for the pairing that polls, and for the folders attached to that sandbox too
// (`followSandbox`).
const pauseIfLongUnreachable = async (mutagen: string, pairing: Pairing, unreachableForMs: number, log: Log): Promise<boolean> => {
    if (pairing.fileSyncAutoPaused === true || !shouldAutoPauseFileSync(unreachableForMs) || !pauseUnreachableSync(mutagen, pairing)) {
        return false;
    }
    await setFileSyncAutoPaused(pairingKey(pairing), true);
    log(
        `  ${pairingKey(pairing)}: unreachable for one hour; paused its Mutagen sessions to stop permanent reconnect/scanning load. They resume automatically when it returns.`,
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
    fate: FateSeams,
    log: Log,
): Promise<{ readonly drop: boolean; readonly paused: boolean }> => {
    // The edge's final word: the sandbox is marked gone (and held still) rather than counted as one more failed poll.
    if (error instanceof SandboxGoneError) {
        await sandboxSaidGone(fate, pairing.sandboxId, "edge");
        return { drop: true, paused: true };
    }
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
    await guard(log, `${pairingKey(pairing)}: clearing derived residue`, async () => void (await healDerivedConflicts(mutagen, pairing, log)));
};

// Which setup of a pairing this is. Every `setup` mints a fresh sync token, so a pairing set up again (another folder,
// a takeover, a re-pair after an unpair) reads as new here and is prepared again; one that is merely re-read does not.
// So does a project whose direction was switched (`sync direction`): the mode is what its session is recreated for.
// So does a docker pairing moved onto ssh (gone-watch.ts `checkContainers`), whose session is made again over the other
// transport.
const setupOf = (pairing: Pairing): string =>
    [pairingKey(pairing), pairing.localDir ?? "", pairing.syncToken ?? "", syncMode(pairing), pairingTransport(pairing)].join("\n");

// The pairings this pass has to prepare: every setup the watcher has not seen. Pure, so "each setup exactly once" is a
// rule with a test rather than a branch in the loop.
export const unpreparedSetups = (pairings: readonly Pairing[], prepared: ReadonlySet<string>): Pairing[] =>
    pairings.filter((held) => !prepared.has(setupOf(held)));

export const markPrepared = (prepared: Set<string>, pairing: Pairing): void => void prepared.add(setupOf(pairing));

// One pairing's sessions brought to this build's rules. Whatever did not get there (a create that failed, or a
// replacement put off until the sandbox answers or its conflicts settle) is pending, and retried on the cadence below.
const prepareSession = async (mutagen: string, pairing: Pairing, pending: Set<string>, relabels: RelabelBudget, say: Log): Promise<boolean> => {
    let converged = false;
    await guard(say, `${pairingKey(pairing)}: preparing its file sync`, async () => {
        converged = await ensureSyncSession(mutagen, pairing, say, relabels);
    });
    if (converged) {
        pending.delete(pairingKey(pairing));
    } else {
        pending.add(pairingKey(pairing));
    }
    return converged;
};

// A pairing whose sessions this watcher paused because its sandbox stopped answering. Paused sessions do nothing, so
// bringing them to new rules can wait: a replacement dials the sandbox first, once per session, and against one that
// has been gone for an hour each dial can run to the tunnel's ten-second timeout. A dogfooding PC had 6 of its 8
// pairings in this state: twelve such dials at every agent start, before mirroring or reporting began. Only while its
// sessions exist, since a pairing that has none is not syncing anything and nothing else would create them.
// (2026-10-05) So is a pairing whose sandbox is gone, or whose sessions the watcher holds for a reason of its own
// (config.ts `fileSyncPausedFor`): nothing is made or replaced for a sandbox that is not there. A listing that did not
// answer counts as sessions held, the side that makes nothing.
const dormant = (mutagen: string, pairing: Pairing): boolean =>
    pairing.goneSince !== undefined ||
    pairing.fileSyncPausedFor !== undefined ||
    (pairing.fileSyncAutoPaused === true && (existingSyncSessions(mutagen, syncSessionNames(pairing)) ?? [undefined]).length > 0);

// BEFORE A FOLDER'S FIRST COPY, ITS SANDBOX IS TOLD OF IT. The daemon makes an attached folder's `/work/<name>` a
// repository of its own once a report names it. A session that began filling `/work/<name>` first would leave those
// files untracked in the sandbox's root repository for a while, where a commit there could take them. So a folder
// attached to a sandbox whose session does not exist yet gets one only after a report naming it was taken, and is
// tried again on the next tick when it was not. One report per sandbox and pass, however many of its folders wait.
// Pure over its two seams, so "never a first copy before the report" is a rule with a test.
export const readyToPrepare = async (
    setups: readonly Pairing[],
    firstCopyAhead: (pairing: Pairing) => boolean,
    announce: (pairing: Pairing) => Promise<boolean>,
): Promise<Pairing[]> => {
    const told = new Map<string, boolean>();
    const ready: Pairing[] = [];
    for (const pairing of setups) {
        if (isAttachedPairing(pairing) && pairing.mode === "sync" && pairing.localDir !== undefined && firstCopyAhead(pairing)) {
            // oxlint-disable-next-line eslint/no-await-in-loop -- one report per sandbox, and the folders of one wait on it
            const said = told.get(pairing.sandboxId) ?? (await announce(pairing));
            told.set(pairing.sandboxId, said);
            if (!said) {
                continue;
            }
        }
        ready.push(pairing);
    }
    return ready;
};

// The real announcement: the report as it stands (the new folder in it, with no session yet), posted to the folder's
// sandbox. A daemon with no report route (404) cannot be waiting for one, so the folder goes ahead; a sandbox whose
// polls are backing off is not asked more often than they are.
const announcer =
    (
        mutagen: string,
        bases: DaemonBases,
        unsupported: Set<string>,
        unreachable: ReadonlyMap<string, Unreachable>,
        gone: (pairing: Pairing) => Promise<void>,
        say: Log,
    ) =>
    async (pairing: Pairing): Promise<boolean> => {
        // Nothing is announced to a sandbox said to be gone; its folder waits with it.
        if (pairing.goneSince !== undefined) {
            return false;
        }
        if (pairing.syncToken === undefined || unsupported.has(pairing.sandboxId)) {
            return true;
        }
        if (!pollDue(unreachable.get(pairing.sandboxId), Date.now())) {
            return false;
        }
        try {
            const response = await sendReport(await bases.resolve(pairing), pairing, await deviceReport(mutagen));
            if (response.status === 404) {
                unsupported.add(pairing.sandboxId);
                say(`  ${pairing.sandboxId}: this sandbox is running a daemon without machine reports, its Devices view will stay empty.`);
                return true;
            }
            if (answeredGone(response)) {
                await gone(pairing);
                return false;
            }
            if (!response.ok) {
                say(
                    `  ${pairingKey(pairing)}: ${pairing.sandboxId} did not take the report naming this folder (${response.status}); its first copy waits for it.`,
                );
            }
            return response.ok;
        } catch (error) {
            say(
                `  ${pairingKey(pairing)}: ${pairing.sandboxId} could not be told of this folder (${errorMessage(error)}); its first copy waits until it can.`,
            );
            return false;
        }
    };

// Every pairing this watcher has not prepared yet. At startup that is all of them, which is where an upgraded agent's
// inherited sessions pick up the new rules, since Mutagen bakes them in at creation. After that it is each pairing a
// `setup` or an `attach` adds or sets up again while the watcher runs. Per pairing, so one dead sandbox costs only
// itself; a dormant one is left pending for the cadence below, and a folder whose sandbox has not been told of it yet
// stays unprepared, to be tried again next pass (`readyToPrepare`).
// THE WATCHER IS THE ONLY THING THAT CREATES SESSIONS. `setup` used to create them too, at the same moment the agent it
// had just started was preparing the same pairing, so each create found no session and both went ahead: one name came
// to hold two identical sessions over the same folder, each flagging the other's writes as conflicts.
// (2026-10-05) A docker pairing's container is asked after first (gone-watch.ts `checkContainers`): the transport was
// decided at setup and never asked again, so a session was made, or kept, through a container that was gone.
const prepareSessions = async (
    mutagen: string,
    pairings: readonly Pairing[],
    prepared: Set<string>,
    pending: Set<string>,
    announce: (pairing: Pairing) => Promise<boolean>,
    passes: Pick<PassContext, "fate" | "relabels" | "tracking">,
    say: Log,
): Promise<void> => {
    // A listing that did not answer reads as a first copy ahead: announcing again costs one report.
    const firstCopyAhead = (pairing: Pairing): boolean => (existingSyncSessions(mutagen, syncSessionNames(pairing)) ?? []).length === 0;
    const unprepared = unpreparedSetups(pairings, prepared);
    const docker = unprepared.filter((pairing) => pairingTransport(pairing) === "docker");
    if (docker.length > 0) {
        await guard(
            say,
            "asking after the containers docker pairings reach",
            async () => await checkContainers(passes.fate, docker, answeringOf(passes.tracking)),
        );
    }
    for (const pairing of await readyToPrepare(unprepared, firstCopyAhead, announce)) {
        markPrepared(prepared, pairing);
        if (dormant(mutagen, pairing)) {
            pending.add(pairingKey(pairing));
            continue;
        }
        await prepareSession(mutagen, pairing, pending, passes.relabels, say);
    }
};

// Whether a sandbox's own poll is answering, as this watcher has seen it.
const answeringOf =
    (tracking: Pick<PairingTracking, "unreachable">) =>
    (sandboxId: string): boolean =>
        !tracking.unreachable.has(sandboxId);

// The same work on a cadence, for the pairings whose file sync has not reached this build's rules: asleep,
// mid-rebuild, behind a transport that was not yet open, or holding conflicts a replacement has to wait out. A dormant
// one waits until its sandbox answers again and the pause is lifted. The common case is an empty set and no work.
const retryPendingSessions = async (
    mutagen: string,
    pairings: readonly Pairing[],
    sessionsPending: Set<string>,
    tick: number,
    relabels: RelabelBudget,
    say: Log,
): Promise<void> => {
    if (sessionsPending.size === 0 || tick % SESSION_RETRY_EVERY_TICKS !== 0) {
        return;
    }
    for (const pairing of pairings.filter((held) => sessionsPending.has(pairingKey(held)) && !dormant(mutagen, held))) {
        if (await prepareSession(mutagen, pairing, sessionsPending, relabels, say)) {
            say(`  ${pairingKey(pairing)}: file sync is running on this build's rules`);
        }
    }
};

// File sync held still for every pairing whose sandbox ic is swapping on this machine (swap-pause.ts): paused as the
// swap begins, resumed once it has held, and the pause kept on disk so an agent restarted mid-swap still lifts it.
// Answers the pairings held this pass, whose git bridge and heal wait too: both would read a sandbox mid-swap.
const holdSyncDuringSwaps = async (
    mutagen: string,
    pairings: readonly Pairing[],
    unreachable: ReadonlyMap<string, Unreachable>,
    say: Log,
): Promise<ReadonlySet<string>> => {
    const records = await readSwapRecords();
    const now = Date.now();
    const held = new Set<string>();
    for (const pairing of pairings) {
        const record = recordOf(pairing, records);
        const holds = holdsSync(record, now, !unreachable.has(pairing.sandboxId));
        if (holds) {
            held.add(pairing.sandboxId);
        }
        const step = swapPauseStep(pairing, holds);
        if (step === "pause" && pauseRunningSync(mutagen, pairing)) {
            // oxlint-disable-next-line eslint/no-await-in-loop -- state is a single file; serial keeps the writes ordered
            await setFileSyncSwapPaused(pairingKey(pairing), true);
            say(`  ${pairingKey(pairing)}: its sandbox is being swapped on this machine; file sync is paused until the new version has held.`);
        } else if (step === "resume") {
            resumeSwapPausedSync(mutagen, pairing);
            // oxlint-disable-next-line eslint/no-await-in-loop -- ditto
            await setFileSyncSwapPaused(pairingKey(pairing), false);
            say(`  ${pairingKey(pairing)}: its sandbox's swap is settled; file sync resumed.`);
        }
    }
    return held;
};

/** Everything one pairing's pass needs that is the same for all of them, so the pass itself takes three arguments. */
interface PassContext {
    readonly mutagen: string;
    readonly tick: number;
    // Ports this tick's earlier pairings already took, added to as this one takes its own.
    readonly claimedBy: Map<number, string>;
    // Whose forward every port is: each pairing's record as the tick began, replaced by its pass once that has run
    // (`recordedForwards`, `handOver`). It only names a holder in a skip; `claimedBy` alone decides.
    readonly holding: Map<number, string>;
    readonly tracking: PairingTracking;
    readonly bases: DaemonBases;
    // Pairings whose sandbox is mid-swap on this machine, held still this pass.
    readonly swapHeld: ReadonlySet<string>;
    // What this machine's Docker publishes, and when each port a pass found busy was first seen free again.
    readonly holders: HolderMemory;
    // How a sandbox's fate is acted on (gone-watch.ts), and how many legacy sessions this pass may relabel.
    readonly fate: FateSeams;
    readonly relabels: RelabelBudget;
    // Says this watcher is still moving, for its own stall check (`watchGeneration`).
    readonly progress: (step: string) => void;
    // Every pairing as this tick read them: a sandbox's answer clears a gone mark any of its pairings carries.
    readonly pairings: readonly Pairing[];
    readonly say: Log;
}

// One pairing's whole pass: poll and reconcile its ports, sweep what it strands, heal, bridge. Lifted out of the agent
// so the agent stays a list of what a tick does, rather than one function in which every branch is one pairing's
// business.
const runPairingPass = async (context: PassContext, pairing: Pairing, base: string): Promise<void> => {
    const { mutagen, tick, claimedBy, holding, tracking, bases, swapHeld, fate, say } = context;
    const { rejectedPolls, unreachable, repos } = tracking;
    const swapping = swapHeld.has(pairing.sandboxId);
    let pausedThisPass = false;
    try {
        const mirrored = await servePairing(context, pairing, base);
        rejectedPolls.delete(pairing.sandboxId);
        unreachable.delete(pairing.sandboxId);
        // It answered: whatever said it was gone is withdrawn, from every pairing of it (a folder attached to it keeps
        // the mark when its projects host was set up again), and the outage clock on disk stops.
        if (context.pairings.some((held) => held.sandboxId === pairing.sandboxId && held.goneSince !== undefined)) {
            await sandboxAnswered(fate, pairing.sandboxId);
        }
        if (context.pairings.some((held) => held.sandboxId === pairing.sandboxId && held.unreachableSince !== undefined)) {
            await setUnreachableSince(pairing.sandboxId, undefined);
        }
        // Still pending if it was: a replacement put off while the sandbox slept is owed now that it answers. Not while
        // its sandbox is mid-swap, which holds that sync still whoever paused it.
        if (!swapping && resumeAutoPausedSync(mutagen, pairing)) {
            await setFileSyncAutoPaused(pairingKey(pairing), false);
            say(`  ${pairingKey(pairing)}: reachable again; resumed its automatically paused file sync`);
        }
        // A folder attached to its sandbox mirrors nothing, and its sandbox's forwards are not its to hand over or sweep.
        if (!isAttachedPairing(pairing)) {
            for (const port of mirrored) {
                claimedBy.set(port.port, pairing.sandboxId);
            }
            handOver(holding, pairing.sandboxId, mirrored);
            // Only on a pass that reconciled, and with the list that pass produced: against a stale record this would
            // take down live forwards rather than stranded ones.
            if (tick % STRANDED_SWEEP_EVERY_TICKS === 0) {
                sweepStrandedForwards(mutagen, pairing.sandboxId, mirrored, say);
            }
        }
    } catch (error) {
        // Reports that this pass's resolved base failed, which daemon-base.ts can't detect itself; matters only for a
        // loopback base, so the next tick falls back to the public URL instead of the pairing just failing.
        bases.failed(pairing.sandboxId);
        const outcome = await absorbPairingFailure(error, mutagen, pairing, tracking, fate, say);
        if (outcome.drop) {
            return;
        }
        pausedThisPass = outcome.paused;
        // A transient tunnel blip must not kill the agent, log and try again next tick.
        say(`  ${pairingKey(pairing)}: reconcile skipped: ${errorMessage(error)}`);
    }
    // Auto-paused pairings still get the probe above but skip the SSH-heavy git bridge below, as do those mid-swap, and
    // those the watcher holds still for a reason of its own (a gone sandbox among them, until it answered just now).
    if (pairing.fileSyncAutoPaused === true || pairing.fileSyncPausedFor !== undefined || pausedThisPass || swapping) {
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

// WHICH PAIRINGS POLL their sandbox's ports, which is also how a sandbox's liveness and a revoked enrollment are
// noticed: one per sandbox. That is the sandbox's own pairing (the projects host, or any pairing made before folders
// could attach), else the first folder attached to it. Every other folder attached to that sandbox follows what the
// poll found (`followSandbox`) rather than asking again, so ten folders cost the daemon one poll, not eleven.
export const pollingPairings = (pairings: readonly Pick<Pairing, "sandboxId" | "key">[]): ReadonlySet<string> => {
    const polling = new Set<string>();
    for (const sandboxId of new Set(pairings.map((pairing) => pairing.sandboxId))) {
        const own = pairings.filter((pairing) => pairing.sandboxId === sandboxId);
        const poller = own.find((pairing) => !isAttachedPairing(pairing)) ?? own[0];
        if (poller !== undefined) {
            polling.add(pairingKey(poller));
        }
    }
    return polling;
};

// The whole pass of a folder attached to a sandbox that another pairing polls: its file sync paused after an hour of
// that sandbox not answering and resumed once it answers, as the poller's own is, then the heal (which a copy-first
// folder never needs). No ports, no git bridge: the folder is the owner's project, and the projects host mirrors. A
// folder of a sandbox said to be gone was paused with the rest of it (gone-watch.ts), and does nothing more here.
const followSandbox = async (context: PassContext, pairing: Pairing): Promise<void> => {
    const { mutagen, tick, tracking, swapHeld, say } = context;
    if (pairing.goneSince !== undefined || pairing.fileSyncPausedFor !== undefined) {
        return;
    }
    // The outage as the poller's pass recorded it, or as it stands on disk from before this agent started.
    const down = tracking.unreachable.get(pairing.sandboxId)?.since ?? pairing.unreachableSince;
    const swapping = swapHeld.has(pairing.sandboxId);
    if (down === undefined) {
        if (!swapping && resumeAutoPausedSync(mutagen, pairing)) {
            await setFileSyncAutoPaused(pairingKey(pairing), false);
            say(`  ${pairingKey(pairing)}: reachable again; resumed its automatically paused file sync`);
        }
    } else if (await pauseIfLongUnreachable(mutagen, pairing, Date.now() - down, say)) {
        return;
    }
    if (pairing.fileSyncAutoPaused === true || swapping) {
        return;
    }
    await healPairing(mutagen, pairing, tick, say);
};

// What a pass does about a polling pairing whose sandbox was said to be gone (gone.ts `goneStep`): nothing until its
// hour is up, a poll when it is (the pass itself, which clears the mark if the sandbox answers), and past the trash
// window the retirement. Answers whether this pass polls as usual ("pass"), polls whatever the backoff says ("ask"), or
// does nothing more ("skip").
const passGone = async (context: PassContext, pairing: Pairing): Promise<"pass" | "ask" | "skip"> => {
    const now = Date.now();
    const step = goneStep(pairing, now);
    if (step === undefined) {
        return "pass";
    }
    // The hour is counted from the asking, whatever the answer: a recheck that met an outage instead of a verdict is
    // not asked again every tick.
    if (step === "recheck") {
        await setSandboxGone(pairing.sandboxId, { since: pairing.goneSince ?? now, checkedAt: now, by: pairing.goneBy ?? "edge" });
        return "ask";
    }
    if (step === "retire") {
        const { mutagen, tracking, say } = context;
        await guard(say, `${pairing.sandboxId}: retiring its pairing`, async () => {
            await retireSandbox(pairing.sandboxId, say, `gone since ${new Date(pairing.goneSince ?? Date.now()).toISOString().slice(0, 10)}`, {
                mutagen,
            });
        });
        tracking.unreachable.delete(pairing.sandboxId);
        tracking.rejectedPolls.delete(pairing.sandboxId);
        tracking.repos.delete(pairing.sandboxId);
        for (const key of [...tracking.sessionsPending].filter((held) => keyOfSandbox(held, pairing.sandboxId))) {
            tracking.sessionsPending.delete(key);
        }
    }
    return "skip";
};

// Every pairing's pass for one tick. The pairings that poll go first, so a folder following its sandbox reads this
// tick's answer.
const runPasses = async (
    context: PassContext,
    dialed: readonly Dialed<Pairing>[],
    pairings: readonly Pairing[],
    live: () => boolean,
): Promise<void> => {
    const polling = pollingPairings(pairings);
    for (const { pairing, base } of dialed.filter((held) => polling.has(pairingKey(held.pairing)))) {
        if (!live()) {
            return;
        }
        // A sandbox said to be gone is asked again only hourly, and retired past the trash window.
        // oxlint-disable-next-line eslint/no-await-in-loop -- one sandbox at a time, as every pass here
        const gone = await passGone(context, pairing);
        if (gone === "skip") {
            continue;
        }
        // A pairing that has been failing for a while is not polled every tick (pollBackoffMs). The record is kept
        // rather than cleared, so the hour that auto-pauses file sync still runs on wall-clock while it waits.
        if (gone === "pass" && !pollDue(context.tracking.unreachable.get(pairing.sandboxId), Date.now())) {
            continue;
        }
        // oxlint-disable-next-line eslint/no-await-in-loop -- One sandbox at a time keeps tunnel state ordered.
        await runPairingPass(context, pairing, base);
        context.progress(`${pairingKey(pairing)}'s pass`);
    }
    for (const { pairing } of dialed.filter((held) => !polling.has(pairingKey(held.pairing)))) {
        if (!live()) {
            return;
        }
        // oxlint-disable-next-line eslint/no-await-in-loop -- one folder at a time, as every pass here
        await guard(context.say, `${pairingKey(pairing)}: following its sandbox`, async () => await followSandbox(context, pairing));
    }
};

// (2026-10-05) How often the standing sweeps run, in ticks of POLL_MS: Mutagen sessions no pairing claims (once a
// minute, where it ran only at the watcher's start, a setup and a revocation), and the containers docker pairings reach.
const ORPHAN_SWEEP_EVERY_TICKS = 12;
const CONTAINER_CHECK_EVERY_TICKS = 12;
// And this machine's ic, asked whether the sandboxes kept here still exist: an ic listing costs a `docker ps` and an
// inspect of every container, so every ten minutes, and only on a machine that keeps one of its pairings' sandboxes.
const KEPT_HERE_CHECK_EVERY_TICKS = 120;

// The sandboxes whose daemon this pass reached on this machine's loopback: kept here, whatever ic has said so far.
const reachedLocally = (dialed: readonly Dialed<Pairing>[]): ReadonlySet<string> =>
    new Set(
        dialed.flatMap(({ pairing, base }) => {
            const candidates = candidateBases(pairing.sandboxUrl);
            return candidates.length > 1 && candidates[0] === base ? [pairing.sandboxId] : [];
        }),
    );

// The standing sweeps of one pass, each on its own cadence and each against the state as it stands after the pass:
// Mutagen sessions no pairing claims, the containers docker pairings reach, and this machine's ic.
const standingSweeps = async (
    context: Pick<PassContext, "mutagen" | "tick" | "tracking" | "fate" | "say">,
    dialed: readonly Dialed<Pairing>[],
): Promise<void> => {
    const { mutagen, tick, tracking, fate, say } = context;
    if (tick > 0 && tick % ORPHAN_SWEEP_EVERY_TICKS === 0) {
        await guard(say, "retiring orphaned sessions", async () => retireOrphanSessions(mutagen, (await readState()).pairings, say));
    }
    if (tick % CONTAINER_CHECK_EVERY_TICKS === 0) {
        await guard(
            say,
            "asking after the containers docker pairings reach",
            async () => await checkContainers(fate, (await readState()).pairings, answeringOf(tracking)),
        );
    }
    if (tick % KEPT_HERE_CHECK_EVERY_TICKS === 0) {
        await guard(
            say,
            "asking this machine's ic which sandboxes it keeps",
            async () => await checkKeptHere(fate, (await readState()).pairings, reachedLocally(dialed)),
        );
    }
};

/* A WATCHER THAT STOPPED MOVING IS RESTARTED, NOT ONLY REPORTED (2026-10-05). The heartbeat this loop stamps at the end
   of each pass was only ever reported: an await that never settled (a child with no bound, a socket nothing closed) left
   the process up, the pidfile claimed, mirroring, the git bridge and file sync stopped, and `status` saying "stalled"
   to nobody. Every child call is bounded now, and on top of that the loop marks its progress at every step; a loop with
   no progress for WATCHER_STALL_MS is abandoned (it stops at its next step, whenever its stuck await returns), its
   tunnels are released, it says so in one line, and a fresh loop takes over with fresh memory. The agent's own hang
   watchdog (watchdog.ts) is for the other kind of stuck: an event loop that cannot run at all. */
export const WATCHER_STALL_MS = 20 * 60_000;
const STALL_CHECK_MS = 30_000;

// Whether a loop last seen moving at `progress` counts as stuck. Longer than any one bounded step (a create is five
// minutes, a git fetch two), so only a step that will never end trips it.
export const watcherStalled = (progress: number, now: number): boolean => now - progress >= WATCHER_STALL_MS;

/** One run of the loop, and how its stall check reads it. */
interface Generation {
    abandoned: boolean;
    progress: number;
    step: string;
    stopTransports: (() => Promise<void>) | undefined;
}

export const runMirrorWatch = async (log: Log): Promise<void> => {
    for (;;) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- one loop at a time; a stalled one is replaced, never joined
        if ((await watchGeneration(log)) === "done") {
            return;
        }
    }
};

// One loop under its stall check: "done" when the loop ended by itself (nothing left paired), "stalled" when it was
// abandoned. A loop that throws throws through, as it always did, for the resident agent's retry ladder.
const watchGeneration = async (log: Log): Promise<"done" | "stalled"> => {
    const generation: Generation = { abandoned: false, progress: Date.now(), step: "starting", stopTransports: undefined };
    const loop = watchLoop(log, generation);
    let timer: NodeJS.Timeout | undefined;
    const stall = new Promise<"stalled">((resolve) => {
        timer = setInterval(() => {
            if (watcherStalled(generation.progress, Date.now())) {
                resolve("stalled");
            }
        }, STALL_CHECK_MS);
    });
    try {
        const outcome = await Promise.race([loop.then(() => "done" as const), stall]);
        if (outcome === "stalled") {
            generation.abandoned = true;
            // Whatever the abandoned loop does when its stuck step returns is its own; it stops at its next check.
            loop.catch(() => undefined);
            log(
                `sync watcher: no progress for ${WATCHER_STALL_MS / 60_000} minutes (it was at: ${generation.step}); restarting it. Its heartbeat had gone stale, which \`intentic-machine status\` reports.`,
            );
            await generation.stopTransports?.().catch(() => undefined);
        }
        return outcome;
    } finally {
        clearInterval(timer);
    }
};

/** What one run of the loop holds for its lifetime, built once by `startWatch` and read by every `watchTick`. */
interface Watch {
    readonly log: Log;
    readonly say: Log;
    readonly mutagen: string;
    readonly live: () => boolean;
    readonly progress: (step: string) => void;
    readonly tunnels: ReturnType<typeof createTunnelPool>;
    readonly bases: DaemonBases;
    readonly tracking: PairingTracking;
    readonly sessionsPrepared: Set<string>;
    readonly reportUnsupported: Set<string>;
    readonly fate: FateSeams;
    readonly gone: (pairing: Pairing) => Promise<void>;
    readonly announce: (pairing: Pairing) => Promise<boolean>;
    readonly holders: HolderMemory;
    // The ssh config fragment as last written, so a tick writes it again only when its pairings' transports changed.
    sshConfig: string;
}

const watchLoop = async (log: Log, generation: Generation): Promise<void> => {
    const watch = await startWatch(log, generation);
    if (watch === undefined) {
        return;
    }
    for (let tick = 0; watch.live(); tick += 1) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- the tick loop itself, serial by definition
        if ((await watchTick(watch, tick)) === "stop") {
            return;
        }
        // oxlint-disable-next-line eslint/no-await-in-loop -- ditto
        await sleep(POLL_MS);
    }
};

// Everything a run holds for its lifetime, and its first preparation; undefined when nothing is paired at all.
const startWatch = async (log: Log, generation: Generation): Promise<Watch | undefined> => {
    const mutagen = await ensureMutagen();
    // Everything below runs every POLL_MS for the life of the machine, so everything below says what it has to say
    // through the quiet rule (repeats.ts) rather than once per tick per pairing.
    const say = quieted(log);
    sayDaemonEventsTo(say);
    // Nothing paired is terminal, logged once, not spammed every tick for the life of the session.
    const initial = await readState();
    if (initial.pairings.length === 0) {
        log("no sandboxes are paired: nothing to mirror. Enable it from a sandbox's Desktop sync card.");
        return undefined;
    }
    // This process puts the sandbox's sshd on loopback (tunnel.ts) before any session needs it; reconciled again
    // every tick so a pairing added or dropped mid-run gains or loses its transport without a restart.
    // Regenerated here, not only by setup/uninstall, so an upgraded binary's dialing rules reach an old pairing
    // without a fresh browser token. Idempotent and cheap when already correct. Written again whenever the pairings it
    // is made of change their transport (a docker pairing moved onto ssh, a pairing retired).
    const sshConfig = pairingSshConfig(initial.pairings);
    await guard(say, "refreshing the ssh configuration", async () => await writeManagedSshConfig(sshConfig));
    const tunnels = createTunnelPool(say);
    generation.stopTransports = tunnels.stopAll;
    // Where each pairing's daemon is dialled, held for the watcher's lifetime (daemon-base.ts owns the policy) and
    // cached per sandbox, so most ticks cost only a map lookup.
    const bases = createDaemonBases(say);
    await guard(
        say,
        "opening the sync transports",
        async () => await tunnels.reconcile(tunnelTargets(await dialedPairings(initial.pairings, bases))),
    );
    // Per-sandbox state keyed by sandbox id, and the sessions still owed by pairing key; entries come and go with them.
    const tracking: PairingTracking = { rejectedPolls: new Map(), unreachable: new Map(), repos: new Map(), sessionsPending: new Set() };
    // Sandboxes with no machine-report route, retired from reporting for this watcher's lifetime.
    const reportUnsupported = new Set<string>();
    const fate: FateSeams = { mutagen, releaseForwards: async (sandboxId) => await retirePairingMirror(mutagen, sandboxId), say };
    const gone = async (pairing: Pairing): Promise<void> => await sandboxSaidGone(fate, pairing.sandboxId, "edge");
    const watch: Watch = {
        log,
        say,
        mutagen,
        live: () => !generation.abandoned,
        progress: (step) => {
            generation.progress = Date.now();
            generation.step = step;
        },
        tunnels,
        bases,
        tracking,
        sessionsPrepared: new Set(),
        reportUnsupported,
        fate,
        gone,
        announce: announcer(mutagen, bases, reportUnsupported, tracking.unreachable, gone, say),
        // What the bind probe cannot see, kept for the watcher's lifetime: Docker's answer, cached, and the grace each
        // port a pass found busy is serving. Only the busy rows reach the disk, so a restart starts every grace over.
        holders: { dockerPorts: publishedPortsReader(say), freeSince: new Map() },
        sshConfig,
    };
    await prepareSessions(
        mutagen,
        initial.pairings,
        watch.sessionsPrepared,
        tracking.sessionsPending,
        watch.announce,
        { fate, relabels: relabelBudget(1), tracking },
        say,
    );
    await guard(say, "retiring orphaned sessions", () => retireOrphanSessions(mutagen, initial.pairings, say));
    log(`sync started; polling ${plural(initial.pairings.length, "paired sandbox")} every ${POLL_MS / 1000}s`);
    return watch;
};

// One tick: "stop" when nothing is paired any more (or this run was abandoned), "next" otherwise.
const watchTick = async (watch: Watch, tick: number): Promise<"next" | "stop"> => {
    const { mutagen, say, tracking, fate, progress } = watch;
    progress("the start of a pass");
    // Re-read every tick so a concurrent setup/uninstall takes effect without restarting the watcher.
    const state = await readState().catch((error: unknown) => {
        say(`  tick skipped: the sync state didn't read (${errorMessage(error)})`);
        return undefined;
    });
    // Unparseable state (setup caught mid-write): wait and retry rather than spin; heartbeat stays where it was.
    if (state === undefined) {
        return "next";
    }
    if (state.pairings.length === 0) {
        // Nothing left to sync: stops this half for good rather than polling empty forever. A pairing revoked mid-loop
        // lands here next tick.
        await watch.tunnels.stopAll();
        watch.log("no sandboxes are paired any more: sync stopping. Re-enable from a sandbox's Desktop sync card.");
        return "stop";
    }
    const wantedConfig = pairingSshConfig(state.pairings);
    if (wantedConfig !== watch.sshConfig) {
        await guard(say, "refreshing the ssh configuration", async () => await writeManagedSshConfig(wantedConfig));
        watch.sshConfig = wantedConfig;
    }
    // Where this pass dials each pairing, decided once and shared by the transport reconcile, ports poll, and report
    // below. Cached, so a tick pays for a probe only when the answer could have moved.
    const dialed = await dialedPairings(state.pairings, watch.bases);
    // Runs before the port reconcile and git bridge, both of which ride this transport; a newly added pairing needs
    // its listener up first, and a moved base gets rebound here too.
    await guard(say, "reconciling the sync transports", async () => await watch.tunnels.reconcile(tunnelTargets(dialed)));
    progress("the sync transports");
    // One legacy session relabelled per pass at most (mutagen.ts RelabelBudget).
    const relabels = relabelBudget(1);
    // After the transport reconcile above, which is what a new pairing's sessions ride, and what a session that
    // failed to create was usually waiting on.
    await prepareSessions(
        mutagen,
        state.pairings,
        watch.sessionsPrepared,
        tracking.sessionsPending,
        watch.announce,
        { fate, relabels, tracking },
        say,
    );
    await retryPendingSessions(mutagen, state.pairings, tracking.sessionsPending, tick, relabels, say);
    progress("preparing file sync");
    if (!watch.live()) {
        return "stop";
    }
    let swapHeld: ReadonlySet<string> = new Set();
    await guard(say, "holding file sync still during swaps", async () => {
        swapHeld = await holdSyncDuringSwaps(mutagen, state.pairings, tracking.unreachable, say);
    });
    // Ports this tick's earlier pairings already own, so a later one is told who holds a port it wanted. And whose
    // forward each port is meanwhile, so a pairing listed before its holder does not file it as busy.
    const context: PassContext = {
        mutagen,
        tick,
        claimedBy: new Map(),
        holding: recordedForwards(state.pairings),
        tracking,
        bases: watch.bases,
        swapHeld,
        holders: watch.holders,
        fate,
        relabels,
        progress,
        pairings: state.pairings,
        say,
    };
    await runPasses(context, dialed, state.pairings, watch.live);
    if (!watch.live()) {
        return "stop";
    }
    // Runs after the pairings: servePairing just persisted this tick's ports, and the report re-reads that state, so
    // reporting last reports this tick, not the previous one.
    if (tick % REPORT_EVERY_TICKS === 0) {
        await guard(say, "posting this machine's reports", async () => await postReports(dialed, mutagen, watch.reportUnsupported, watch.gone, say));
    }
    await standingSweeps(context, dialed);
    progress("the end of a pass");
    // Stamped at the bottom of the pass that did the work: its whole meaning is that everything above it ran. A tick
    // skipped for unparseable state leaves it where it was.
    await beat();
    return "next";
};

// Terminates one sandbox's forward sessions (or every one this agent owns with no id given), read from the
// daemon, not a config baseline: Mutagen keeps a forward's listener bound even after its sandbox is gone. The record
// that moves with them is the sandbox's own pairing's: a folder attached to it holds none.
// A listing that did not answer falls back to what the record says is mirrored, by name: the forwards this agent knows
// it made, rather than none.
const teardownForwards = async (mutagen: string, sandboxId?: string): Promise<number> => {
    const recorded = async (): Promise<string[]> =>
        (await readState()).pairings
            .filter((held) => sandboxId === undefined || held.sandboxId === sandboxId)
            .flatMap((held) => (held.mirroredPorts ?? []).map((port) => forwardSessionName(held.sandboxId, port.port)));
    const names = ourForwardSessions(mutagen, sandboxId) ?? (await recorded());
    if (names.length > 0) {
        spawnSync(mutagen, ["forward", "terminate", ...names], { stdio: "ignore", windowsHide: true, timeout: MUTAGEN_CALL_TIMEOUT_MS });
    }
    // A stale baseline would make the next reconcile treat gone forwards as already mirrored. The skip set clears
    // too: mirroring-off isn't the same as losing a contest. `ignoredPorts` survives, being a choice rather than a
    // reading: mirroring switched off and back on must not silently take back a number somebody released.
    await updateState((state) => ({
        pairings: state.pairings.map((held) =>
            (sandboxId === undefined || held.sandboxId === sandboxId) && !isAttachedPairing(held)
                ? { ...held, mirroredPorts: [], skippedPorts: [] }
                : held,
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
    spawnSync(mutagen, ["forward", "terminate", forwardSessionName(sandboxId, port)], {
        stdio: "ignore",
        windowsHide: true,
        timeout: MUTAGEN_CALL_TIMEOUT_MS,
    });
    let wasMirrored = false;
    await updateState((state) => ({
        pairings: state.pairings.map((held) => {
            if (held.sandboxId !== sandboxId || isAttachedPairing(held)) {
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
