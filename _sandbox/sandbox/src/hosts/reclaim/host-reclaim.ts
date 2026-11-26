import { writeFile } from "node:fs/promises";
import { errnoCode, errorMessage } from "@intentic/base/errors";
import type { HostRoom } from "@intentic/constants/memory-room";
import { HOST_HEARTBEAT_MS } from "@intentic/sandbox-contract/protocol/doors/host-protocol";
import { hostMemoryLowBytes } from "@intentic/sandbox-contract/schemas/hosts";
import type { Logger } from "pino";
import type { PressureSnapshot } from "../../system/resources/cgroup.js";
import type { HostSource } from "../../workload/resource-budget.js";

/* TARGETED CGROUP RECLAIM UNDER HOST PRESSURE (2026-11-26). When the host (the Windows PC this sandbox runs on) is
   under its low line, each sandbox reclaims from its own cgroup via `memory.reclaim` instead of waiting for the
   machine agent's blanket `drop_caches`, which throws away every sandbox's whole file cache. Each sandbox sees the same
   shortfall and must not reclaim the full amount: the target is split by own size × idleness, so an idle sandbox gives
   back more than one with turns running. Cold file cache is preferred (swappiness=0 when active, swappiness=200 when
   idle to let cold anon into zram). memory.pressure is watched: reclaim stops when the sandbox is stalling.

   WHAT WINDOWS GOT BACK, MEASURED ON ROG (2026-11-26, Windows under its low line at 1.3-3.6 GiB of 31.4). A 1 GiB
   `memory.reclaim` from this sandbox's cgroup took 0.4-1.1 s and raised the VM's MemFree by about 1 GiB, but almost all
   of it in blocks under 64 KiB, which free page reporting (page_reporting_order 5) cannot hand back, and the VM had
   used it again within 4-8 s; vmmemWSL and Windows' Available memory did not move beyond their second-to-second noise
   (±100 MiB) in the 30 s after, with or without `compact_memory` straight after the reclaim. So a reclaim's effect on
   the host is read back a settle later and logged, and one the host did not feel makes the next one wait longer
   (nextReclaimCooldown), as the machine agent's drops back off: the cache is not churned every minute for nothing. */

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;
const CGROUP_RECLAIM = "/sys/fs/cgroup/memory.reclaim";

// At most one reclaim this often, and its effect on the host is read back this long after it: the host's reading arrives
// with each heartbeat, so two of them hold one taken at least a heartbeat after the reclaim.
export const RECLAIM_COOLDOWN_MS = 2 * HOST_HEARTBEAT_MS;

// How long the wait between reclaims can grow after reclaims the host did not feel (nextReclaimCooldown).
export const MAX_RECLAIM_COOLDOWN_MS = 10 * 60_000;

// Memory pressure (PSI full avg10) above which reclaim is skipped: an active turn is stalling and reclaiming would
// make it worse.
export const PRESSURE_CEILING_PERCENT = 15;

// A sandbox smaller than this is not asked to reclaim: it has little to give and the overhead is not worth it.
const MIN_RECLAIM_SANDBOX_BYTES = 512 * MIB;

// The minimum reclaim target: below this the write is not worth the syscall.
const MIN_RECLAIM_BYTES = 8 * MIB;

// The maximum one pass reclaims, so a large idle sandbox does not freeze itself handing everything back at once.
const MAX_RECLAIM_BYTES = 2 * GIB;

// How many sandboxes the shortfall is assumed to be split across when weighting: the host has several tenants, each
// seeing the same shortfall. A sandbox that holds more of the VM's memory, or is more idle, takes a larger share.
// This is a divisor on the raw shortfall before weighting, not a count of actual sandboxes (which the sandbox cannot
// know). Two means: "assume at least one other tenant shares this host".
const ASSUMED_TENANTS = 2;

const gib = (bytes: number): string => `${(bytes / GIB).toFixed(2)} GiB`;
const mib = (bytes: number): string => `${Math.round(bytes / MIB)} MiB`;

export interface ReclaimReading {
    readonly memoryBytes: number | undefined;
    readonly pressure: { readonly memory?: PressureSnapshot | undefined };
}

// Pure: how many bytes this sandbox should reclaim given the host shortfall, the sandbox's cgroup size, and whether
// it has active turns. Returns 0 when reclaim should not run.
export const reclaimTarget = (
    host: HostRoom,
    cgroup: ReclaimReading,
    activeTurns: number,
): number => {
    if (cgroup.memoryBytes === undefined || cgroup.memoryBytes < MIN_RECLAIM_SANDBOX_BYTES) {
        return 0;
    }
    // The host's shortfall: how far it is below the low line.
    const lowLine = hostMemoryLowBytes(host.totalBytes);
    const shortfall = lowLine - host.availableBytes;
    if (shortfall <= 0) {
        return 0;
    }

    // Memory pressure too high: an active turn is grinding, do not make it worse.
    const memoryPressure = cgroup.pressure.memory;
    if (memoryPressure !== undefined && memoryPressure.full >= PRESSURE_CEILING_PERCENT) {
        return 0;
    }

    // Weight by size × idleness: a larger sandbox gives more, an idle one gives more.
    // Idleness: 1.0 when no turns run, 0.3 when turns are active (still reclaim, but less).
    const idleness = activeTurns > 0 ? 0.3 : 1.0;
    // The sandbox's share of the shortfall, weighted by its own size relative to a "full" sandbox (the host's total).
    // This is an approximation: the sandbox cannot know other tenants' sizes.
    const sizeWeight = Math.min(1, cgroup.memoryBytes / (host.totalBytes / ASSUMED_TENANTS));
    const share = (shortfall / ASSUMED_TENANTS) * sizeWeight * idleness;

    // Clamp to the reclaimable range.
    const target = Math.min(MAX_RECLAIM_BYTES, Math.max(0, share));
    return target < MIN_RECLAIM_BYTES ? 0 : Math.round(target);
};

// Pure: the wait before the next reclaim, after one that gave back `givenBytes` and saw the host's available memory move
// by `gainedBytes` a RECLAIM_COOLDOWN_MS later. The host gaining at least half of it brings the base pace back; less
// doubles the wait, up to MAX_RECLAIM_COOLDOWN_MS.
export const nextReclaimCooldown = (cooldownMs: number, givenBytes: number, gainedBytes: number): number =>
    givenBytes > 0 && gainedBytes >= givenBytes / 2 ? RECLAIM_COOLDOWN_MS : Math.min(MAX_RECLAIM_COOLDOWN_MS, cooldownMs * 2);

// Whether the kernel's memory.reclaim accepts a `swappiness=` key. Tested once; cached.
let swappinessSupported: boolean | undefined;
const probeSwappiness = async (
    write: (path: string, data: string) => Promise<void> = (path, data) => writeFile(path, data),
): Promise<boolean> => {
    if (swappinessSupported !== undefined) {
        return swappinessSupported;
    }
    try {
        // A zero-byte reclaim with swappiness: if the kernel accepts the key, it succeeds (or reclaims nothing);
        // if it does not understand the key, it fails with EINVAL.
        await write(CGROUP_RECLAIM, "0 swappiness=0");
        swappinessSupported = true;
    } catch {
        // allow(silent-catch): EINVAL or ENOSYS means the key is not supported; other failures (EACCES) are treated
        // the same way since we cannot distinguish them cheaply
        swappinessSupported = false;
    }
    return swappinessSupported;
};

// Reset for tests.
export const resetSwappinessProbe = (): void => {
    swappinessSupported = undefined;
};

// Write the reclaim request to the cgroup.
const writeReclaim = async (
    bytes: number,
    swappiness: number | undefined,
    write: (path: string, data: string) => Promise<void> = (path, data) => writeFile(path, data),
): Promise<void> => {
    const payload = swappiness !== undefined ? `${bytes} swappiness=${swappiness}` : `${bytes}`;
    await write(CGROUP_RECLAIM, payload);
};

// memory.reclaim answers EAGAIN when it took less than asked, measured 2026-11-26 on an empty cgroup: the pass still ran,
// so its effect is read and logged like a full one. A file that cannot be written at all (a kernel before 5.19 has none,
// a read-only cgroup mount refuses it) stays so for the daemon's life: reclaim turns itself off after saying so once,
// rather than warning every RECLAIM_COOLDOWN_MS for as long as the host is low.
const UNWRITABLE = new Set(["EACCES", "EPERM", "EROFS", "ENOENT"]);
type WriteOutcome = "full" | "partial" | "failed" | "unwritable";

const reclaimWrite = async (
    logger: Pick<Logger, "warn">,
    target: number,
    swappiness: number | undefined,
    write: (path: string, data: string) => Promise<void>,
): Promise<WriteOutcome> => {
    try {
        await writeReclaim(target, swappiness, write);
        return "full";
    } catch (error) {
        const code = errnoCode(error);
        if (code === "EAGAIN") {
            return "partial";
        }
        const unwritable = code !== undefined && UNWRITABLE.has(code);
        logger.warn(
            { target: mib(target), error: errorMessage(error) },
            unwritable ? "host-reclaim: memory.reclaim cannot be written here; reclaim is off until the daemon restarts" : "host-reclaim: write failed",
        );
        return unwritable ? "unwritable" : "failed";
    }
};

export interface HostReclaimDeps {
    readonly hostSource: HostSource;
    readonly readCgroup: () => Promise<ReclaimReading>;
    // How many agent turns are running in this sandbox right now.
    readonly activeTurns: () => number;
    readonly now?: () => number;
    readonly write?: (path: string, data: string) => Promise<void>;
}

export interface HostReclaim {
    // Called on each host heartbeat or resource sample; never throws.
    readonly tick: () => void;
    // For tests: one pass, awaitable.
    readonly pass: () => Promise<void>;
}

// A reclaim whose effect on the host is still to be read back.
interface Given {
    readonly at: number;
    readonly hostBefore: number;
    readonly bytes: number;
}

// The host a settle after the last reclaim, logged; answers the wait before the next reclaim (nextReclaimCooldown), or
// `cooldownMs` unchanged when the host cannot be read.
const readBack = async (
    logger: Pick<Logger, "info">,
    hostSource: HostSource,
    last: Given,
    cooldownMs: number,
    now: number,
): Promise<number> => {
    const host = await hostSource();
    if (host === undefined) {
        return cooldownMs;
    }
    const gained = host.availableBytes - last.hostBefore;
    const next = nextReclaimCooldown(cooldownMs, last.bytes, gained);
    logger.info(
        { given: mib(last.bytes), hostBefore: gib(last.hostBefore), hostAfter: gib(host.availableBytes), hostGained: mib(gained), nextReclaimInS: next / 1000 },
        `host-reclaim: ${Math.round((now - last.at) / 1000)} s after this sandbox gave back ${mib(last.bytes)}, the host had ${gib(host.availableBytes)} available (${gib(last.hostBefore)} before); the next reclaim waits ${next / 1000} s`,
    );
    return next;
};

interface Asked {
    readonly host: HostRoom;
    readonly cgroup: ReclaimReading;
    readonly turns: number;
    readonly target: number;
}

// One reclaim of `asked.target` from this cgroup, logged with the cgroup before and after; answers how it went and what
// it gave back (a full reclaim took at least the target, whatever else filled the cgroup meanwhile).
const reclaimOnce = async (
    logger: Pick<Logger, "info" | "warn">,
    { host, cgroup, turns, target }: Asked,
    readCgroup: () => Promise<ReclaimReading>,
    write: (path: string, data: string) => Promise<void>,
): Promise<{ readonly outcome: WriteOutcome; readonly bytes: number }> => {
    // Prefer cold file cache when active (swappiness=0); let cold anon into zram when idle (swappiness=200).
    const swappiness = (await probeSwappiness(write)) ? (turns > 0 ? 0 : 200) : undefined;
    const outcome = await reclaimWrite(logger, target, swappiness, write);
    if (outcome === "failed" || outcome === "unwritable") {
        return { outcome, bytes: 0 };
    }
    const beforeBytes = cgroup.memoryBytes ?? 0;
    const afterBytes = (await readCgroup()).memoryBytes ?? 0;
    const freed = Math.max(0, beforeBytes - afterBytes);
    logger.info(
        {
            hostAvailable: gib(host.availableBytes),
            hostTotal: gib(host.totalBytes),
            lowLine: gib(hostMemoryLowBytes(host.totalBytes)),
            target: mib(target),
            before: mib(beforeBytes),
            after: mib(afterBytes),
            freed: mib(freed),
            partial: outcome === "partial",
            swappiness,
            activeTurns: turns,
        },
        `host-reclaim: reclaimed ${mib(freed)} (target ${mib(target)}${outcome === "partial" ? ", the kernel found no more to take" : ""}) from this sandbox's cgroup; host had ${gib(host.availableBytes)} of ${gib(host.totalBytes)} available`,
    );
    return { outcome, bytes: outcome === "full" ? Math.max(freed, target) : freed };
};

export const startHostReclaim = (
    logger: Pick<Logger, "info" | "warn">,
    deps: HostReclaimDeps,
): HostReclaim => {
    const now = deps.now ?? Date.now;
    const writeFn = deps.write ?? ((path: string, data: string) => writeFile(path, data));
    let lastReclaimAt = Number.NEGATIVE_INFINITY;
    let cooldownMs = RECLAIM_COOLDOWN_MS;
    let given: Given | undefined;
    let off = false;
    let underway: Promise<void> | undefined;

    const attempt = async (): Promise<void> => {
        if (given !== undefined) {
            if (now() - given.at < RECLAIM_COOLDOWN_MS) {
                return;
            }
            const last = given;
            given = undefined;
            cooldownMs = await readBack(logger, deps.hostSource, last, cooldownMs, now());
        }
        if (off || now() - lastReclaimAt < cooldownMs) {
            return;
        }

        // Read the host's state; no host means no Windows reading, so plain Linux: untouched.
        const host = await deps.hostSource();
        if (host === undefined) {
            return;
        }
        if (host.availableBytes >= hostMemoryLowBytes(host.totalBytes)) {
            cooldownMs = RECLAIM_COOLDOWN_MS;
            return;
        }

        const cgroup = await deps.readCgroup();
        const turns = deps.activeTurns();
        const target = reclaimTarget(host, cgroup, turns);
        if (target === 0) {
            return;
        }
        lastReclaimAt = now();
        const { outcome, bytes } = await reclaimOnce(logger, { host, cgroup, turns, target }, deps.readCgroup, writeFn);
        off = outcome === "unwritable";
        if (outcome === "full" || outcome === "partial") {
            given = { at: lastReclaimAt, hostBefore: host.availableBytes, bytes };
        }
    };

    const pass = async (): Promise<void> => {
        try {
            await attempt();
        } catch (error) {
            logger.warn({ error: errorMessage(error) }, "host-reclaim: unexpected failure");
        }
    };

    return {
        pass,
        tick: () => {
            if (underway !== undefined) {
                return;
            }
            underway = pass().finally(() => {
                underway = undefined;
            });
        },
    };
};
