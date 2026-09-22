import { appendFile, mkdir, readFile, readdir } from "node:fs/promises";
import { loadavg } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay, performance, PerformanceObserver } from "node:perf_hooks";
import { getHeapSpaceStatistics, getHeapStatistics } from "node:v8";
import { PROCESS_ROLES, type ProcessRole } from "@intentic/sandbox-contract";
import { gitSpawnStats } from "@intentic/scaffold";
import type { Logger } from "pino";
import { logsRoot } from "../../logs/log-files.js";
import { parsePressure, type PressureSnapshot } from "./loop-watchdog.js";
import { parseProcStat } from "./proc-stat.js";
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

// Program names a row may be labelled with, longer spellings first so `vue-tsc` is not read as `tsc`. A label is one of
// these words or nothing, never argv, which can carry a provider prompt or a path.
const PROGRAMS = [
    "vue-tsc",
    "vitest",
    "tsc",
    "tsgo",
    "turbo",
    "vite",
    "esbuild",
    "tsdown",
    "oxlint",
    "prettier",
    "knip",
    "pnpm",
    "npm",
    "npx",
    "yarn",
    "bun",
    "claude",
    "codex",
    "opencode",
    "gemini",
    "kimi",
    "chrome",
    "chromium",
    "firefox",
    "webkit",
    "playwright",
    "llama-server",
    "ollama",
    "tsserver",
    "iq-engine",
    "iq",
    "git",
    "tmux",
    "postgres",
    "nginx",
    "dockerd",
    "containerd",
    "node",
] as const;

// A program name as a whole word or path component; `-` counts as a boundary so `google-chrome` and `containerd-shim`
// name their programs, and `.` and `@` close one so `vite.js` and pnpm's `vitest@4.0.0` do too.
const programPattern = (name: string): RegExp => new RegExp(`(^|[ /-])${name}([ /.@-]|$)`, "u");

const PROGRAM_PATTERNS = PROGRAMS.map((name) => [name, programPattern(name)] as const);

export const programOf = (command: string): string | undefined => {
    const value = command.toLowerCase();
    return PROGRAM_PATTERNS.find(([, pattern]) => pattern.test(value))?.[0];
};

// The toolchain: what a turn's build, test or typecheck runs, and the package manager that drives it. `tsgo` counts
// only as a one-shot check; serving `--lsp` it is a language server below.
const TOOLCHAIN = [
    "vue-tsc",
    "vitest",
    "tsc",
    "turbo",
    "vite",
    "esbuild",
    "tsdown",
    "oxlint",
    "prettier",
    "knip",
    "pnpm",
    "npm",
    "npx",
    "yarn",
    "bun",
].map(programPattern);
const TSGO = /(^|[ /])tsgo([ .]|$)/u;
const isToolchain = (value: string): boolean => TOOLCHAIN.some((pattern) => pattern.test(value)) || (TSGO.test(value) && !/--lsp\b/u.test(value));

// A nested container's process, by the cgroup it sits in, or the engine that runs it, by name.
const CONTAINER_CGROUP = /[/]docker[/]/u;
const CONTAINER = /(^|[ /])(dockerd|containerd|docker-proxy|docker-init|runc)([ /-]|$)/u;

const LOCAL_MODEL = /(^|[ /-])(llama-server|llama-cli|llamafile|ollama)([ /.-]|$)/u;

const BROWSER = /chrom(e|ium)|firefox|webkit|playwright|browser-mcp|browser_server/u;
const LANGUAGE_SERVER =
    /typescript-language-server|tsserver|rust-analyzer|pyright|pylsp|gopls|clangd|jdtls|solargraph|intelephense|language-server|lsp-daemon/u;
const OWN_LANGUAGE_SERVER = /@intentic[/]lsp|_search[/]lsp|[/]lsp[/]dist[/]cli|(^|[ /])lsp([ /]|$)|(^|[ /])tsgo([ .]|$)/u;
// The search engine is its own role because it is neither an LSP nor noise: it is a long-lived index host with a heap
// cap of its own, and folding it into `other` is what hid 1.64 GB of growth behind a bucket nobody reads.
const SEARCH_ENGINE = /iq-engine|(^|[ /])iq([ /]|$)/u;
const TRANSLATOR = /cli-proxy-api|endpoint-translator|translator-proxy/u;
const EXTENSION = /extension-backend|extension-host|backend-host-main|backend-supervisor/u;
const GIT = /git.*fork.*broker|(^|[ /])git([ /]|$)/u;
const AGENT_RUNTIME = /(^|[ /])(claude|codex|opencode|gemini|kimi)([ /]|$)|agent-runtime/u;
const TERMINAL = /(^|[ /])(tmux|bash|zsh|fish|sshd)([ :/]|$)|node-pty/u;

// In match order: the engine before whatever it runs, Playwright's node MCP before its browser, a one-shot tsgo before
// the language server the same binary can be, the shell that drives a fan-out with the fan-out, the git fork broker
// before git.
const ROLE_RULES: readonly (readonly [ProcessRole, (value: string) => boolean])[] = [
    ["container", (value) => CONTAINER.test(value)],
    ["browser", (value) => BROWSER.test(value)],
    ["localModel", (value) => LOCAL_MODEL.test(value)],
    ["toolchain", isToolchain],
    ["languageServer", (value) => LANGUAGE_SERVER.test(value) || OWN_LANGUAGE_SERVER.test(value)],
    ["searchEngine", (value) => SEARCH_ENGINE.test(value)],
    ["translator", (value) => TRANSLATOR.test(value)],
    ["extension", (value) => EXTENSION.test(value)],
    ["git", (value) => GIT.test(value)],
    ["agentRuntime", (value) => AGENT_RUNTIME.test(value)],
    ["terminal", (value) => TERMINAL.test(value)],
];

// Roles are aggregates; the process rows beside them carry comm and a PROGRAMS word, never argv, which can carry a
// provider prompt or a path. A nested container's process is the container's whatever it runs, by the cgroup it sits in.
export const classifyProcess = (command: string, cgroup = ""): ProcessRole => {
    if (CONTAINER_CGROUP.test(cgroup)) {
        return "container";
    }
    const value = command.toLowerCase();
    return ROLE_RULES.find(([, matches]) => matches(value))?.[0] ?? "other";
};

const readProcess = async (pidText: string): Promise<ProcessRow | undefined> => {
    try {
        const [statusRaw, commandRaw, stat, cgroup] = await Promise.all([
            readFile(`/proc/${pidText}/status`, "utf8"),
            readFile(`/proc/${pidText}/cmdline`, "utf8").catch(() => ""),
            readFile(`/proc/${pidText}/stat`, "utf8"),
            readFile(`/proc/${pidText}/cgroup`, "utf8").catch(() => ""),
        ]);
        const status = parseProcStatus(statusRaw);
        const proc = parseProcStat(stat);
        if (proc?.cpuTicks === undefined) {
            return undefined;
        }
        const command = `${status.name} ${commandRaw.replaceAll("\0", " ")}`;
        return {
            pid: Number(pidText),
            ppid: proc.ppid,
            name: status.name,
            program: programOf(command),
            role: classifyProcess(command, cgroup),
            rssBytes: status.rssBytes,
            swapBytes: status.swapBytes,
            threads: status.threads,
            cpuTicks: proc.cpuTicks,
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
    previousCpu: ReadonlyMap<number, number>,
): Promise<{
    readonly total: ProcessSummary;
    readonly descendants: ProcessSummary;
    readonly byRole: Record<ProcessRole, ProcessSummary>;
    readonly top: TopProcess[];
    readonly cpuByPid: ReadonlyMap<number, number>;
}> => {
    const entries = await readdir("/proc").catch(() => []);
    const rows = (
        await Promise.all(entries.filter((entry) => /^[1-9]\d*$/u.test(entry) && Number(entry) !== process.pid).map((entry) => readProcess(entry)))
    ).filter((row) => row !== undefined);
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
    // Per pool: slots, how many are taken, and the oldest holder's age. A pool at its limit is ordinary; one whose
    // oldest holder keeps climbing between samples is a command that is not coming back.
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

const numberAt = (source: unknown, path: readonly string[]): number | undefined => {
    const value = path.reduce<unknown>(
        (held, key) => (held !== null && typeof held === "object" ? (held as Record<string, unknown>)[key] : undefined),
        source,
    );
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
export const longHeldPools = (snapshot: ResourceSnapshot, thresholdSeconds: number): { readonly pool: string; readonly heldSeconds: number }[] =>
    Object.entries(snapshot.queue).flatMap(([pool, summary]) => {
        const longest = numberAt(summary, ["longestHoldSeconds"]);
        return longest === undefined || longest < thresholdSeconds ? [] : [{ pool, heldSeconds: longest }];
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
                        { pool: held.pool, heldSeconds: held.heldSeconds, at: snapshot.at },
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
