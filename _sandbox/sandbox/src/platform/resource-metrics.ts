import { appendFile, mkdir, readFile, readdir } from "node:fs/promises";
import { loadavg } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay, performance, PerformanceObserver } from "node:perf_hooks";
import { getHeapSpaceStatistics, getHeapStatistics } from "node:v8";
import type { Logger } from "pino";
import { logsRoot } from "../logs/log-files.js";
import { parsePressure, type PressureSnapshot } from "./loop-watchdog.js";

/* A regular, durable account of the sandbox's resources. The stall watchdog answers only after the event loop
 * has already disappeared; this series answers what was growing BEFORE that point, including healthy periods
 * where no warning happened. One compact JSON object per minute makes it easy to diff with jq or load into a
 * dataframe, while keeping the file under the logs tree's existing retention and /logs/file access policy. */

const SAMPLE_INTERVAL_MS = 60_000;
export const RESOURCE_METRICS_FILE = "resource-metrics.jsonl";

export type ProcessRole = "languageServer" | "agentRuntime" | "browser" | "git" | "translator" | "extension" | "terminal" | "other";

interface ProcessRow {
    readonly pid: number;
    readonly ppid: number;
    readonly role: ProcessRole;
    readonly rssBytes: number;
    readonly swapBytes: number;
    readonly threads: number;
    readonly cpuTicks: number;
}

export interface ParsedProcStatus {
    readonly name: string;
    readonly ppid: number;
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
    name: statusText(text, "Name") ?? "",
    ppid: statusNumber(text, "PPid"),
    rssBytes: statusBytes(text, "VmRSS"),
    rssHighWaterBytes: statusBytes(text, "VmHWM"),
    rssAnonymousBytes: statusBytes(text, "RssAnon"),
    rssFileBytes: statusBytes(text, "RssFile"),
    rssSharedBytes: statusBytes(text, "RssShmem"),
    swapBytes: statusBytes(text, "VmSwap"),
    threads: statusNumber(text, "Threads"),
});

/* Only the aggregate is persisted — never argv. Provider prompts, paths and tokens can ride in a command
 * line, and none of them are needed to answer which class of workload owns the memory. Ordering matters where
 * names overlap: Playwright's node MCP belongs with its browser, and the git fork broker belongs with git. */
export const classifyProcess = (command: string): ProcessRole => {
    const value = command.toLowerCase();
    if (/chrom(e|ium)|firefox|webkit|playwright|browser-mcp|browser_server/u.test(value)) {
        return "browser";
    }
    const languageServer =
        /typescript-language-server|tsserver|rust-analyzer|pyright|pylsp|gopls|clangd|jdtls|solargraph|intelephense|language-server|lsp-daemon/u.test(
            value,
        ) || /@intentic[/]lsp|_search[/]lsp|[/]lsp[/]dist[/]cli|(^|[ /])lsp([ /]|$)|(^|[ /])tsgo([ .]|$)/u.test(value);
    if (languageServer) {
        return "languageServer";
    }
    if (/cli-proxy-api|endpoint-translator|translator-proxy/u.test(value)) {
        return "translator";
    }
    if (/extension-backend|extension-host|backend-host-main|backend-supervisor/u.test(value)) {
        return "extension";
    }
    if (/git.*fork.*broker|(^|[ /])git([ /]|$)/u.test(value)) {
        return "git";
    }
    if (/(^|[ /])(claude|codex|opencode|gemini|kimi)([ /]|$)|agent-runtime/u.test(value)) {
        return "agentRuntime";
    }
    if (/(^|[ /])(tmux|bash|zsh|fish|sshd)([ :/]|$)|node-pty/u.test(value)) {
        return "terminal";
    }
    return "other";
};

const cpuTicksOf = (stat: string): number => {
    // `comm` is parenthesized and may contain spaces or `)`, so split only after its LAST closing paren.
    const tail = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return Number(tail[11] ?? 0) + Number(tail[12] ?? 0);
};

const readProcess = async (pidText: string): Promise<ProcessRow | undefined> => {
    try {
        const [statusRaw, commandRaw, stat] = await Promise.all([
            readFile(`/proc/${pidText}/status`, "utf8"),
            readFile(`/proc/${pidText}/cmdline`, "utf8").catch(() => ""),
            readFile(`/proc/${pidText}/stat`, "utf8"),
        ]);
        const status = parseProcStatus(statusRaw);
        const command = `${status.name} ${commandRaw.replaceAll("\0", " ")}`;
        return {
            pid: Number(pidText),
            ppid: status.ppid,
            role: classifyProcess(command),
            rssBytes: status.rssBytes,
            swapBytes: status.swapBytes,
            threads: status.threads,
            cpuTicks: cpuTicksOf(stat),
        };
    } catch {
        // A process exiting between readdir and read is the ordinary case during a sample.
        return undefined;
    }
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
    previousCpu: ReadonlyMap<number, number>,
): Promise<{
    readonly total: ProcessSummary;
    readonly descendants: ProcessSummary;
    readonly byRole: Record<ProcessRole, ProcessSummary>;
    readonly cpuByPid: ReadonlyMap<number, number>;
}> => {
    const entries = await readdir("/proc").catch(() => []);
    const rows = (
        await Promise.all(entries.filter((entry) => /^[1-9]\d*$/u.test(entry) && Number(entry) !== process.pid).map((entry) => readProcess(entry)))
    ).filter((row) => row !== undefined);
    const descendantPids = descendantsOf(rows, process.pid);
    const total = emptyProcessSummary();
    const descendants = emptyProcessSummary();
    const byRole: Record<ProcessRole, ProcessSummary> = {
        languageServer: emptyProcessSummary(),
        agentRuntime: emptyProcessSummary(),
        browser: emptyProcessSummary(),
        git: emptyProcessSummary(),
        translator: emptyProcessSummary(),
        extension: emptyProcessSummary(),
        terminal: emptyProcessSummary(),
        other: emptyProcessSummary(),
    };
    for (const row of rows) {
        addProcess(total, row, previousCpu);
        addProcess(byRole[row.role], row, previousCpu);
        if (descendantPids.has(row.pid)) {
            addProcess(descendants, row, previousCpu);
        }
    }
    return { total, descendants, byRole, cpuByPid: new Map(rows.map((row) => [row.pid, row.cpuTicks])) };
};

const activeResources = (): Record<string, number> => {
    const counts: Record<string, number> = {};
    for (const resource of process.getActiveResourcesInfo()) {
        counts[resource] = (counts[resource] ?? 0) + 1;
    }
    return Object.fromEntries(Object.entries(counts).toSorted(([left], [right]) => left.localeCompare(right)));
};

const numericFile = async (path: string): Promise<number | undefined> => {
    const value = await readFile(path, "utf8").catch(() => undefined);
    if (value === undefined || value.trim() === "max") {
        return undefined;
    }
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : undefined;
};

const keyValueNumbers = (text: string): Record<string, number> =>
    Object.fromEntries(
        text
            .trim()
            .split("\n")
            .map((line) => line.trim().split(/\s+/u))
            .filter((parts): parts is [string, string] => parts.length === 2 && Number.isFinite(Number(parts[1])))
            .map(([key, value]) => [key.replace(/:$/u, ""), Number(value)]),
    );

const systemSnapshot = async (): Promise<{
    readonly memory: Record<string, number>;
    readonly cgroup: Record<string, number | undefined>;
    readonly pressure: Record<"memory" | "cpu" | "io", PressureSnapshot | undefined>;
    readonly loadAverage: readonly number[];
}> => {
    const [meminfo, memoryCurrentBytes, memoryLimitBytes, swapCurrentBytes, swapLimitBytes, memoryEvents, memoryPressure, cpuPressure, ioPressure] =
        await Promise.all([
            readFile("/proc/meminfo", "utf8").catch(() => ""),
            numericFile("/sys/fs/cgroup/memory.current"),
            numericFile("/sys/fs/cgroup/memory.max"),
            numericFile("/sys/fs/cgroup/memory.swap.current"),
            numericFile("/sys/fs/cgroup/memory.swap.max"),
            readFile("/sys/fs/cgroup/memory.events", "utf8").catch(() => ""),
            readFile("/proc/pressure/memory", "utf8").catch(() => ""),
            readFile("/proc/pressure/cpu", "utf8").catch(() => ""),
            readFile("/proc/pressure/io", "utf8").catch(() => ""),
        ]);
    const memoryFields = keyValueNumbers(meminfo.replaceAll(/\s+kB$/gmu, ""));
    return {
        memory: {
            totalBytes: (memoryFields["MemTotal"] ?? 0) * 1024,
            availableBytes: (memoryFields["MemAvailable"] ?? 0) * 1024,
            swapTotalBytes: (memoryFields["SwapTotal"] ?? 0) * 1024,
            swapFreeBytes: (memoryFields["SwapFree"] ?? 0) * 1024,
        },
        cgroup: {
            memoryCurrentBytes,
            memoryLimitBytes,
            swapCurrentBytes,
            swapLimitBytes,
            ...Object.fromEntries(Object.entries(keyValueNumbers(memoryEvents)).map(([key, value]) => [`event_${key}`, value])),
        },
        pressure: {
            memory: parsePressure(memoryPressure),
            cpu: parsePressure(cpuPressure),
            io: parsePressure(ioPressure),
        },
        loadAverage: loadavg(),
    };
};

const finiteMs = (nanoseconds: number): number => (Number.isFinite(nanoseconds) ? Math.round(nanoseconds / 1e3) / 1e3 : 0);

export interface ResourceSnapshot {
    readonly schema: 1;
    readonly at: string;
    readonly uptimeSeconds: number;
    readonly window: unknown;
    readonly daemon: unknown;
    readonly system: unknown;
    readonly processes: unknown;
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
        const selfStatusPromise = readFile("/proc/self/status", "utf8")
            .then(parseProcStatus)
            .catch(() => undefined);
        const openFdsPromise = readdir("/proc/self/fd")
            .then((entries) => entries.length)
            .catch(() => undefined);
        const processesPromise = processSnapshot(previousProcessCpu);
        const [selfStatus, openFds, processes, system] = await Promise.all([selfStatusPromise, openFdsPromise, processesPromise, systemSnapshot()]);
        previousProcessCpu = processes.cpuByPid;
        const heap = getHeapStatistics();
        const snapshot: ResourceSnapshot = {
            schema: 1,
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
            },
            system,
            processes: { total: processes.total, descendants: processes.descendants, byRole: processes.byRole },
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
    readonly logger: Pick<Logger, "warn">;
    readonly owners?: () => Readonly<Record<string, unknown>>;
    readonly intervalMs?: number;
    readonly sampler?: ResourceSampler;
}

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
        })()
            .catch((error: unknown) => {
                // One warning per uninterrupted failure spell. A read-only/missing history volume should be
                // visible, but repeating the same warning every minute would evict the useful daemon log.
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
