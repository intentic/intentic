import { appendFile, mkdir, readdir } from "node:fs/promises";
import { loadavg } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay, performance, PerformanceObserver } from "node:perf_hooks";
import { getHeapSpaceStatistics, getHeapStatistics } from "node:v8";
import { PROCESS_ROLES, type ProcessRole } from "@intentic/sandbox-contract";
import { gitSpawnStats } from "@intentic/scaffold";
import type { Logger } from "pino";
import { logsRoot } from "../../logs/log-files.js";
import { flatKeyed, readCgroup, readText } from "./cgroup.js";
import { createProcessScanner, type ScannedProcess } from "./process-scan.js";
import { queueSnapshot } from "./queue-slots.js";

// Durable, one-line-per-minute account of the sandbox's resources: what was growing before an event-loop stall,
// including healthy periods with no warning. Stored under the logs tree's retention and /logs/file access policy.

const SAMPLE_INTERVAL_MS = 60_000;
export const RESOURCE_METRICS_FILE = "resource-metrics.jsonl";

export interface ProcessRow {
    readonly pid: number;
    readonly ppid: number;
    // The kernel's comm: an executable's basename, 15 characters, and "MainThread" for every node process.
    readonly name: string;
    readonly program: string | undefined;
    readonly role: ProcessRole;
    readonly rssBytes: number;
    readonly swapBytes: number;
    readonly threads: number;
    readonly cpuTicks: number;
}

export interface ParsedProcStatus {
    readonly rssBytes: number;
    readonly rssHighWaterBytes: number;
    readonly rssAnonymousBytes: number;
    readonly rssFileBytes: number;
    readonly rssSharedBytes: number;
    readonly swapBytes: number;
    readonly threads: number;
}

const statusText = (text: string, key: string): string | undefined => new RegExp(`^${key}:\\s+(.+)$`, "mu").exec(text)?.[1]?.trim();
const statusNumber = (text: string, key: string): number => Number(statusText(text, key)?.split(/\s+/u)[0] ?? 0);
const statusBytes = (text: string, key: string): number => statusNumber(text, key) * 1024;

export const parseProcStatus = (text: string): ParsedProcStatus => ({
    rssBytes: statusBytes(text, "VmRSS"),
    rssHighWaterBytes: statusBytes(text, "VmHWM"),
    rssAnonymousBytes: statusBytes(text, "RssAnon"),
    rssFileBytes: statusBytes(text, "RssFile"),
    rssSharedBytes: statusBytes(text, "RssShmem"),
    swapBytes: statusBytes(text, "VmSwap"),
    threads: statusNumber(text, "Threads"),
});

// Swap is only in status, so each scanned process is read once more; one gone since the scan is not a row.
const rowOf = async ({ pid, ppid, comm, program, role, cpuTicks }: ScannedProcess): Promise<ProcessRow | undefined> => {
    const status = await readText(`/proc/${pid}/status`);
    if (status === undefined || cpuTicks === undefined) {
        return undefined;
    }
    const { rssBytes, swapBytes, threads } = parseProcStatus(status);
    return { pid, ppid, name: comm, program, role, rssBytes, swapBytes, threads, cpuTicks };
};

interface ProcessSummary {
    count: number;
    rssBytes: number;
    swapBytes: number;
    threads: number;
    cpuTicksSincePreviousSample: number;
}

const emptyProcessSummary = (): ProcessSummary => ({ count: 0, rssBytes: 0, swapBytes: 0, threads: 0, cpuTicksSincePreviousSample: 0 });

const addProcess = (summary: ProcessSummary, row: ProcessRow, previousCpu: ReadonlyMap<number, number>): void => {
    summary.count += 1;
    summary.rssBytes += row.rssBytes;
    summary.swapBytes += row.swapBytes;
    summary.threads += row.threads;
    const previous = previousCpu.get(row.pid);
    summary.cpuTicksSincePreviousSample += previous === undefined ? 0 : Math.max(0, row.cpuTicks - previous);
};

// One row per heavy process, so a peak can be attributed after the fact; the roles above only say which bucket it was in.
export interface TopProcess {
    readonly pid: number;
    readonly name: string;
    readonly program: string | undefined;
    readonly role: ProcessRole;
    readonly rssBytes: number;
    readonly swapBytes: number;
    readonly threads: number;
}

const TOP_PROCESSES = 8;

// Heaviest first by resident plus swapped, since a paged-out process is still the one holding the memory.
export const topProcesses = (rows: readonly ProcessRow[], limit: number = TOP_PROCESSES): TopProcess[] =>
    rows
        .toSorted((left, right) => right.rssBytes + right.swapBytes - (left.rssBytes + left.swapBytes))
        .slice(0, limit)
        .map(({ pid, name, program, role, rssBytes, swapBytes, threads }) => ({ pid, name, program, role, rssBytes, swapBytes, threads }));

const descendantsOf = (rows: readonly ProcessRow[], parentPid: number): ReadonlySet<number> => {
    const byPid = new Map(rows.map((row) => [row.pid, row]));
    const descendants = new Set<number>();
    for (const row of rows) {
        const seen = new Set<number>();
        let parent = row.ppid;
        while (parent > 0 && !seen.has(parent)) {
            if (parent === parentPid) {
                descendants.add(row.pid);
                break;
            }
            seen.add(parent);
            parent = byPid.get(parent)?.ppid ?? 0;
        }
    }
    return descendants;
};

const processSnapshot = async (
    scanned: readonly ScannedProcess[],
    previousCpu: ReadonlyMap<number, number>,
): Promise<{
    readonly total: ProcessSummary;
    readonly descendants: ProcessSummary;
    readonly byRole: Record<ProcessRole, ProcessSummary>;
    readonly top: TopProcess[];
    readonly cpuByPid: ReadonlyMap<number, number>;
}> => {
    const rows = (await Promise.all(scanned.map(rowOf))).filter((row) => row !== undefined);
    const descendantPids = descendantsOf(rows, process.pid);
    const total = emptyProcessSummary();
    const descendants = emptyProcessSummary();
    const byRole = Object.fromEntries(PROCESS_ROLES.map((role) => [role, emptyProcessSummary()])) as Record<ProcessRole, ProcessSummary>;
    for (const row of rows) {
        addProcess(total, row, previousCpu);
        addProcess(byRole[row.role], row, previousCpu);
        if (descendantPids.has(row.pid)) {
            addProcess(descendants, row, previousCpu);
        }
    }
    return { total, descendants, byRole, top: topProcesses(rows), cpuByPid: new Map(rows.map((row) => [row.pid, row.cpuTicks])) };
};

const activeResources = (): Record<string, number> => {
    const counts: Record<string, number> = {};
    for (const resource of process.getActiveResourcesInfo()) {
        counts[resource] = (counts[resource] ?? 0) + 1;
    }
    return Object.fromEntries(Object.entries(counts).toSorted(([left], [right]) => left.localeCompare(right)));
};

const systemSnapshot = async (): Promise<Readonly<Record<"memory" | "cgroup" | "pressure" | "loadAverage", unknown>>> => {
    const [meminfo, cgroup] = await Promise.all([readText("/proc/meminfo"), readCgroup()]);
    const memoryFields = flatKeyed(meminfo?.replaceAll(/\s+kB$/gmu, ""));
    return {
        // The host's, which the cgroup's own figures sit inside.
        memory: {
            totalBytes: (memoryFields["MemTotal"] ?? 0) * 1024,
            availableBytes: (memoryFields["MemAvailable"] ?? 0) * 1024,
            swapTotalBytes: (memoryFields["SwapTotal"] ?? 0) * 1024,
            swapFreeBytes: (memoryFields["SwapFree"] ?? 0) * 1024,
        },
        cgroup: {
            memoryCurrentBytes: cgroup.memoryBytes,
            workingSetBytes: cgroup.workingSetBytes,
            memoryLimitBytes: cgroup.memoryLimitBytes,
            swapCurrentBytes: cgroup.swapBytes,
            swapLimitBytes: cgroup.swapLimitBytes,
            ...Object.fromEntries(Object.entries(cgroup.memoryEvents).map(([key, value]) => [`event_${key}`, value])),
        },
        pressure: cgroup.pressure,
        loadAverage: loadavg(),
    };
};

const finiteMs = (nanoseconds: number): number => (Number.isFinite(nanoseconds) ? Math.round(nanoseconds / 1e3) / 1e3 : 0);

export interface ResourceSnapshot {
    readonly schema: 2;
    readonly at: string;
    readonly uptimeSeconds: number;
    readonly window: unknown;
    readonly daemon: unknown;
    readonly system: unknown;
    readonly processes: unknown;
    // Per pool: slots, how many are taken, the oldest holder's age and who it is (queue-slots.ts QueuePoolSummary). A pool
    // at its limit is ordinary; one whose oldest holder keeps climbing between samples is a command not coming back.
    readonly queue: Readonly<Record<string, unknown>>;
    readonly owners: Readonly<Record<string, unknown>>;
}

export interface ResourceSampler {
    readonly sample: () => Promise<ResourceSnapshot>;
    readonly stop: () => void;
}

const createResourceSampler = (owners: () => Readonly<Record<string, unknown>> = () => ({})): ResourceSampler => {
    const loopDelay = monitorEventLoopDelay({ resolution: 20 });
    loopDelay.enable();
    let gcCount = 0;
    let gcTotalMs = 0;
    let gcMaxMs = 0;
    const gcObserver = new PerformanceObserver((entries) => {
        for (const entry of entries.getEntries()) {
            gcCount += 1;
            gcTotalMs += entry.duration;
            gcMaxMs = Math.max(gcMaxMs, entry.duration);
        }
    });
    gcObserver.observe({ entryTypes: ["gc"] });

    let lastCpu = process.cpuUsage();
    let lastUsage = process.resourceUsage();
    let lastElu = performance.eventLoopUtilization();
    let lastAt = performance.now();
    let previousProcessCpu: ReadonlyMap<number, number> = new Map();
    const scanProcesses = createProcessScanner();

    const sample = async (): Promise<ResourceSnapshot> => {
        const now = performance.now();
        const cpu = process.cpuUsage(lastCpu);
        lastCpu = process.cpuUsage();
        const usage = process.resourceUsage();
        const eluNow = performance.eventLoopUtilization();
        const elu = performance.eventLoopUtilization(eluNow, lastElu);
        lastElu = eluNow;
        const elapsedMs = now - lastAt;
        lastAt = now;
        const processMemory = process.memoryUsage();
        const eventLoop = {
            utilization: Math.round(elu.utilization * 10_000) / 10_000,
            activeMs: Math.round(elu.active),
            idleMs: Math.round(elu.idle),
            delayMeanMs: finiteMs(loopDelay.mean),
            delayMaxMs: finiteMs(loopDelay.max),
            delayP50Ms: finiteMs(loopDelay.percentile(50)),
            delayP95Ms: finiteMs(loopDelay.percentile(95)),
            delayP99Ms: finiteMs(loopDelay.percentile(99)),
        };
        const gc = { count: gcCount, totalMs: Math.round(gcTotalMs * 1000) / 1000, maxMs: Math.round(gcMaxMs * 1000) / 1000 };
        const faults = {
            minor: usage.minorPageFault - lastUsage.minorPageFault,
            major: usage.majorPageFault - lastUsage.majorPageFault,
            fsRead: usage.fsRead - lastUsage.fsRead,
            fsWrite: usage.fsWrite - lastUsage.fsWrite,
            voluntaryContextSwitches: usage.voluntaryContextSwitches - lastUsage.voluntaryContextSwitches,
            involuntaryContextSwitches: usage.involuntaryContextSwitches - lastUsage.involuntaryContextSwitches,
        };
        lastUsage = usage;
        loopDelay.reset();
        gcCount = 0;
        gcTotalMs = 0;
        gcMaxMs = 0;
        const selfStatusPromise = readText("/proc/self/status").then((text) => (text === undefined ? undefined : parseProcStatus(text)));
        const openFdsPromise = readdir("/proc/self/fd")
            .then((entries) => entries.length)
            .catch(() => undefined);
        const processesPromise = scanProcesses(process.pid).then((scanned) => processSnapshot(scanned, previousProcessCpu));
        const [selfStatus, openFds, processes, system, queue] = await Promise.all([
            selfStatusPromise,
            openFdsPromise,
            processesPromise,
            systemSnapshot(),
            queueSnapshot(),
        ]);
        previousProcessCpu = processes.cpuByPid;
        const heap = getHeapStatistics();
        const snapshot: ResourceSnapshot = {
            schema: 2,
            at: new Date().toISOString(),
            uptimeSeconds: Math.round(process.uptime()),
            window: {
                elapsedMs: Math.round(elapsedMs),
                cpu: {
                    userMs: Math.round(cpu.user / 1000),
                    systemMs: Math.round(cpu.system / 1000),
                    utilizationPercent: elapsedMs <= 0 ? 0 : Math.round(((cpu.user + cpu.system) / 1000 / elapsedMs) * 10_000) / 100,
                },
                eventLoop,
                gc,
                faults,
            },
            daemon: {
                pid: process.pid,
                memory: {
                    rssBytes: processMemory.rss,
                    heapUsedBytes: processMemory.heapUsed,
                    heapTotalBytes: processMemory.heapTotal,
                    externalBytes: processMemory.external,
                    arrayBuffersBytes: processMemory.arrayBuffers,
                    rssHighWaterBytes: selfStatus?.rssHighWaterBytes,
                    rssAnonymousBytes: selfStatus?.rssAnonymousBytes,
                    rssFileBytes: selfStatus?.rssFileBytes,
                    rssSharedBytes: selfStatus?.rssSharedBytes,
                    swapBytes: selfStatus?.swapBytes,
                },
                v8: {
                    heapSizeLimitBytes: heap.heap_size_limit,
                    totalAvailableBytes: heap.total_available_size,
                    mallocedMemoryBytes: heap.malloced_memory,
                    peakMallocedMemoryBytes: heap.peak_malloced_memory,
                    externalMemoryBytes: heap.external_memory,
                    nativeContexts: heap.number_of_native_contexts,
                    detachedContexts: heap.number_of_detached_contexts,
                    globalHandles: heap.total_global_handles_size,
                    usedGlobalHandles: heap.used_global_handles_size,
                    spaces: Object.fromEntries(
                        getHeapSpaceStatistics().map((space) => [
                            space.space_name,
                            {
                                sizeBytes: space.space_size,
                                usedBytes: space.space_used_size,
                                availableBytes: space.space_available_size,
                                physicalBytes: space.physical_space_size,
                            },
                        ]),
                    ),
                },
                handles: { openFds, threads: selfStatus?.threads, activeResources: activeResources() },
                // queuedBulk > 0 means checkouts are queued, not slow; byRole.git only counts running processes.
                gitSpawn: gitSpawnStats(),
            },
            system,
            processes: { total: processes.total, descendants: processes.descendants, byRole: processes.byRole, top: processes.top },
            queue,
            owners: owners(),
        };
        return snapshot;
    };

    return {
        sample,
        stop: () => {
            loopDelay.disable();
            gcObserver.disconnect();
        },
    };
};

export interface ResourceMetrics {
    readonly sample: () => Promise<void>;
    readonly stop: () => void;
}

export interface ResourceMetricsOptions {
    readonly historyRoot: string;
    readonly logger: Pick<Logger, "warn" | "error">;
    readonly owners?: () => Readonly<Record<string, unknown>>;
    readonly intervalMs?: number;
    readonly sampler?: ResourceSampler;
}

// OOM alarm: logged at error the moment a kill is observed. Reported as a delta since the raw counter is cumulative;
// the first sample after a restart has nothing to diff and is skipped.
const OOM_EVENTS = ["event_oom_kill", "event_oom_group_kill"] as const;

// When a slot holder becomes worth a line in the log. Half of heavy-commands' shipped `maxHoldSeconds`, so a stuck
// command is named while there is still as long again before the ceiling takes the slot back by force.
const SLOT_HOLD_WARN_SECONDS = 15 * 60;

const valueAt = (source: unknown, path: readonly string[]): unknown =>
    path.reduce<unknown>((held, key) => (held !== null && typeof held === "object" ? (held as Record<string, unknown>)[key] : undefined), source);

const numberAt = (source: unknown, path: readonly string[]): number | undefined => {
    const value = valueAt(source, path);
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
};

const roleCounts = (snapshot: ResourceSnapshot): Record<string, number> => {
    const byRole = ((snapshot.processes as Record<string, unknown> | undefined)?.["byRole"] ?? {}) as Record<string, unknown>;
    return Object.fromEntries(
        Object.entries(byRole).flatMap(([role, summary]) => {
            const count = numberAt(summary, ["count"]);
            return count === undefined ? [] : [[role, count]];
        }),
    );
};

// Kills between two samples, with which roles shrank; undefined when nothing was killed.
export const oomSinceSample = (
    previous: ResourceSnapshot,
    current: ResourceSnapshot,
): { readonly kills: Record<string, number>; readonly lostByRole: Record<string, number> } | undefined => {
    const kills = Object.fromEntries(
        OOM_EVENTS.flatMap((event) => {
            const was = numberAt(previous, ["system", "cgroup", event]);
            const now = numberAt(current, ["system", "cgroup", event]);
            return was === undefined || now === undefined || now <= was ? [] : [[event, now - was]];
        }),
    );
    if (Object.keys(kills).length === 0) {
        return undefined;
    }
    const before = roleCounts(previous);
    const after = roleCounts(current);
    const lostByRole = Object.fromEntries(
        Object.entries(before).flatMap(([role, count]) => {
            const lost = count - (after[role] ?? 0);
            return lost > 0 ? [[role, lost]] : [];
        }),
    );
    return { kills, lostByRole };
};

// Pools whose oldest holder has been in place too long. Reads the sample rather than the queue directly, so the line
// in the log and the line on disk can never disagree about what was held.
export const longHeldPools = (
    snapshot: ResourceSnapshot,
    thresholdSeconds: number,
): { readonly pool: string; readonly heldSeconds: number; readonly holder: unknown }[] =>
    Object.entries(snapshot.queue).flatMap(([pool, summary]) => {
        const longest = numberAt(summary, ["longestHoldSeconds"]);
        return longest === undefined || longest < thresholdSeconds
            ? []
            : [{ pool, heldSeconds: longest, holder: valueAt(summary, ["longestHolder"]) }];
    });

const resourceMetricsPath = (historyRoot: string): string => join(logsRoot(historyRoot), RESOURCE_METRICS_FILE);

export const startResourceMetrics = ({
    historyRoot,
    logger,
    owners = () => ({}),
    intervalMs = SAMPLE_INTERVAL_MS,
    sampler: suppliedSampler,
}: ResourceMetricsOptions): ResourceMetrics => {
    if (historyRoot === "") {
        return { sample: async () => {}, stop: () => suppliedSampler?.stop() };
    }
    const sampler = suppliedSampler ?? createResourceSampler(owners);
    let inFlight: Promise<void> | undefined;
    let persistenceFailed = false;
    // Previous sample for the OOM diff, held in memory: a restart has nothing to compare against, on purpose.
    let previous: ResourceSnapshot | undefined;
    // Pools already reported as stuck, so the warning fires on the edge and not every minute the slot stays held.
    let warnedPools = new Set<string>();
    const path = resourceMetricsPath(historyRoot);
    const sample = (): Promise<void> => {
        if (inFlight !== undefined) {
            return inFlight;
        }
        inFlight = (async () => {
            const snapshot = await sampler.sample();
            await mkdir(logsRoot(historyRoot), { recursive: true });
            await appendFile(path, `${JSON.stringify(snapshot)}\n`, "utf8");
            persistenceFailed = false;
            // Persisted before diffing, so the record on disk doesn't depend on the alarm firing.
            const killed = previous === undefined ? undefined : oomSinceSample(previous, snapshot);
            previous = snapshot;
            if (killed !== undefined) {
                logger.error(
                    { ...killed.kills, lostByRole: killed.lostByRole, at: snapshot.at },
                    "the kernel killed processes in this container for running out of memory",
                );
            }
            // Once per spell, per pool: a command that legitimately runs an hour is one line, not sixty. A pool
            // drops out of the set when its oldest holder goes, so the next stuck one is reported again.
            const longHeld = longHeldPools(snapshot, SLOT_HOLD_WARN_SECONDS);
            for (const held of longHeld) {
                if (!warnedPools.has(held.pool)) {
                    logger.warn(
                        { pool: held.pool, heldSeconds: held.heldSeconds, holder: held.holder, at: snapshot.at },
                        "a heavy-command queue slot has been held without finishing; the pool is short by one until it ends",
                    );
                }
            }
            warnedPools = new Set(longHeld.map((held) => held.pool));
        })()
            .catch((error: unknown) => {
                // One warning per failure spell, so a dead history volume doesn't spam the daemon log every minute.
                if (!persistenceFailed) {
                    persistenceFailed = true;
                    logger.warn({ err: error, path }, "resource metrics could not be collected or persisted");
                }
            })
            .finally(() => {
                inFlight = undefined;
            });
        return inFlight;
    };
    void sample();
    const timer = setInterval(() => void sample(), intervalMs);
    timer.unref();
    return {
        sample,
        stop: () => {
            clearInterval(timer);
            sampler.stop();
        },
    };
};
