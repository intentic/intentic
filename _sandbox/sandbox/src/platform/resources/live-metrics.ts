import { statfs } from "node:fs/promises";
import { availableParallelism, freemem, loadavg, totalmem } from "node:os";
import { performance } from "node:perf_hooks";
import type { DaemonUsage, ProcessGroupMetrics, ProcessRole, SandboxMetrics, SandboxUsage, SessionMetrics } from "@intentic/sandbox-contract";
import { DAEMON_OWNER, ONE_SHOT_OWNER } from "../../seams/workload-stamp.js";
import { type CgroupReading, readCgroup, readText } from "./cgroup.js";
import { createProcessScanner, listPids, type ProcSource, type ProcUnits, procUnits } from "./process-scan.js";

// GET /system/metrics: CPU and memory per conversation, per kind of process, and for the sandbox. Runs only inside a
// request and holds no timer; between requests it keeps the counters the next CPU figure is measured from, and what
// each live process was found to be, which is read once in the process's life.

// Requests closer together than this share one reading, so several open boards cost what one does.
const REUSE_MS = 1_000;
// A baseline older than this would average a spell nobody watched, so the reading after it carries no CPU figures.
const BASELINE_MAX_AGE_MS = 10_000;

// Owners that are pools rather than conversations (seams/workload-stamp.ts): counted by kind of process only.
const RESERVED_OWNERS: ReadonlySet<string> = new Set([DAEMON_OWNER, ONE_SHOT_OWNER]);

export interface ProcessSample {
    readonly owner: string | undefined;
    readonly role: ProcessRole;
    readonly rssBytes: number;
    // Its own CPU plus what it collected from children it reaped, in clock ticks, so a finished command stays counted.
    readonly ticks: number;
}

export interface DaemonReading {
    readonly pid: number;
    readonly rssBytes: number;
    readonly heapUsedBytes: number;
    // User plus system CPU of every daemon thread, in microseconds.
    readonly cpuMicros: number;
    // Event-loop time since start, busy and idle, in milliseconds.
    readonly loopActiveMs: number;
    readonly loopIdleMs: number;
}

export interface MachineReading {
    // Cores this process may be scheduled on: the affinity mask, which a cpuset narrows and a CPU quota does not.
    readonly cores: number;
    readonly totalMemoryBytes: number;
    readonly freeMemoryBytes: number;
    readonly loadAverage: readonly [number, number, number];
}

export interface DiskReading {
    readonly usedBytes: number;
    readonly totalBytes: number;
}

// Everything a reading touches outside this module: the real procfs, cgroup and process unless a test hands in a fake.
export interface LiveMetricsSource extends ProcSource {
    readonly disk: (path: string) => Promise<DiskReading | undefined>;
    readonly units: () => Promise<ProcUnits>;
    readonly daemon: () => DaemonReading;
    readonly machine: () => MachineReading;
    // Epoch milliseconds.
    readonly now: () => number;
}

const procSource = (): LiveMetricsSource => ({
    listPids,
    readText,
    disk: (path) =>
        statfs(path)
            .then((volume) => ({ usedBytes: (volume.blocks - volume.bfree) * volume.bsize, totalBytes: volume.blocks * volume.bsize }))
            .catch(() => undefined),
    units: procUnits,
    daemon: () => {
        const memory = process.memoryUsage();
        const cpu = process.cpuUsage();
        const loop = performance.eventLoopUtilization();
        return {
            pid: process.pid,
            rssBytes: memory.rss,
            heapUsedBytes: memory.heapUsed,
            cpuMicros: cpu.user + cpu.system,
            loopActiveMs: loop.active,
            loopIdleMs: loop.idle,
        };
    },
    machine: () => {
        const [one = 0, five = 0, fifteen = 0] = loadavg();
        return { cores: availableParallelism(), totalMemoryBytes: totalmem(), freeMemoryBytes: freemem(), loadAverage: [one, five, fifteen] };
    },
    now: () => Date.now(),
});

interface OwnerTotal {
    processes: number;
    rssBytes: number;
    ticks: number;
}

export interface ProcessTotals {
    // Per conversation; pools and unstamped processes are counted by kind only.
    readonly owners: ReadonlyMap<string, Readonly<OwnerTotal>>;
    readonly roles: Partial<Record<ProcessRole, ProcessGroupMetrics>>;
    // Every scanned process's ticks, the fallback for a sandbox whose cgroup keeps no CPU counter.
    readonly ticks: number;
}

export const totalsOf = (samples: readonly ProcessSample[]): ProcessTotals => {
    const owners = new Map<string, OwnerTotal>();
    const roles: Partial<Record<ProcessRole, { processes: number; rssBytes: number }>> = {};
    let ticks = 0;
    for (const sample of samples) {
        ticks += sample.ticks;
        const role = (roles[sample.role] ??= { processes: 0, rssBytes: 0 });
        role.processes += 1;
        role.rssBytes += sample.rssBytes;
        if (sample.owner === undefined || RESERVED_OWNERS.has(sample.owner)) {
            continue;
        }
        const owner = owners.get(sample.owner) ?? { processes: 0, rssBytes: 0, ticks: 0 };
        owner.processes += 1;
        owner.rssBytes += sample.rssBytes;
        owner.ticks += sample.ticks;
        owners.set(sample.owner, owner);
    }
    return { owners, roles, ticks };
};

// One decimal, never negative: a counter that went backwards lost a member mid-window, which is not negative work.
const roundTenth = (value: number): number => Math.round(Math.max(0, value) * 10) / 10;

// Each conversation's CPU is the growth of its processes' ticks, children they reaped included; a group that did not
// exist at the baseline started inside the window, so all of its ticks are.
export const sessionsOf = (
    totals: ProcessTotals,
    baseline: ReadonlyMap<string, number> | undefined,
    windowMs: number | undefined,
    ticksPerSecond: number,
): Record<string, SessionMetrics> =>
    Object.fromEntries(
        [...totals.owners].map(([owner, total]) => [
            owner,
            {
                processes: total.processes,
                rssBytes: total.rssBytes,
                ...(baseline === undefined || windowMs === undefined
                    ? {}
                    : { cpuPercent: roundTenth(((total.ticks - (baseline.get(owner) ?? 0)) / ticksPerSecond / (windowMs / 1000)) * 100) }),
            },
        ]),
    );

export interface SandboxUsageInput {
    readonly cgroup: CgroupReading;
    readonly machine: MachineReading;
    readonly disk: DiskReading | undefined;
    readonly processes: number;
    // CPU the sandbox used over the window, in cores; undefined on a first reading.
    readonly coresUsed: number | undefined;
}

// Capacity is the quota where there is one, and never more than the cores the sandbox can be given.
export const sandboxUsageOf = ({ cgroup, machine, disk, processes, coresUsed }: SandboxUsageInput): SandboxUsage => {
    const cores = Math.min(cgroup.cpuQuotaCores ?? Number.POSITIVE_INFINITY, machine.cores);
    const { cpu, memory, io } = cgroup.pressure;
    return {
        ...(coresUsed === undefined ? {} : { cpuPercent: roundTenth((coresUsed / cores) * 100) }),
        cores,
        memoryBytes: cgroup.workingSetBytes ?? Math.max(0, machine.totalMemoryBytes - machine.freeMemoryBytes),
        memoryLimitBytes: Math.min(cgroup.memoryLimitBytes ?? Number.POSITIVE_INFINITY, machine.totalMemoryBytes),
        ...(cgroup.swapBytes === undefined ? {} : { swapBytes: cgroup.swapBytes }),
        ...(disk === undefined ? {} : { diskBytes: disk.usedBytes, diskTotalBytes: disk.totalBytes }),
        loadAverage: [...machine.loadAverage],
        processes,
        ...(cpu === undefined || memory === undefined || io === undefined ? {} : { pressure: { cpu: cpu.some, memory: memory.some, io: io.some } }),
    };
};

export const daemonUsageOf = (now: DaemonReading, before: DaemonReading | undefined, windowMs: number | undefined): DaemonUsage => {
    const loopMs = before === undefined ? 0 : now.loopActiveMs + now.loopIdleMs - (before.loopActiveMs + before.loopIdleMs);
    return {
        rssBytes: now.rssBytes,
        heapUsedBytes: now.heapUsedBytes,
        ...(before === undefined || windowMs === undefined
            ? {}
            : { cpuPercent: roundTenth(((now.cpuMicros - before.cpuMicros) / 1000 / windowMs) * 100) }),
        ...(before === undefined || loopMs <= 0 ? {} : { eventLoopPercent: roundTenth(((now.loopActiveMs - before.loopActiveMs) / loopMs) * 100) }),
    };
};

// Counters the next reading measures CPU against, and the only thing a reading leaves behind besides identities.
interface Baseline {
    readonly at: number;
    readonly ownerTicks: ReadonlyMap<string, number>;
    readonly processTicks: number;
    readonly cgroupCpuMicros: number | undefined;
    readonly daemon: DaemonReading;
}

// Absent on a first reading, after a quiet spell, or when the clock stepped back: then there is no honest CPU figure.
const measurableFrom = (baseline: Baseline | undefined, at: number): Baseline | undefined =>
    baseline !== undefined && at > baseline.at && at - baseline.at <= BASELINE_MAX_AGE_MS ? baseline : undefined;

// CPU the sandbox used between two sets of counters, in milliseconds: the cgroup's own counter where there is one, else
// every process's, which misses whatever exited without a scanned parent reaping it.
const sandboxCpuMs = (now: Baseline, since: Baseline, ticksPerSecond: number): number =>
    now.cgroupCpuMicros !== undefined && since.cgroupCpuMicros !== undefined
        ? (now.cgroupCpuMicros - since.cgroupCpuMicros) / 1000
        : ((now.processTicks - since.processTicks) / ticksPerSecond) * 1000 + (now.daemon.cpuMicros - since.daemon.cpuMicros) / 1000;

export interface LiveMetrics {
    // A fresh reading, the one in flight, or one taken under REUSE_MS ago; never a figure measured without a request.
    readonly read: () => Promise<SandboxMetrics>;
}

export const createLiveMetrics = ({
    workspaceRoot,
    source = procSource(),
}: {
    readonly workspaceRoot: string;
    readonly source?: LiveMetricsSource;
}): LiveMetrics => {
    const scan = createProcessScanner(source);
    let baseline: Baseline | undefined;
    let last: SandboxMetrics | undefined;
    let inFlight: Promise<SandboxMetrics> | undefined;

    const sample = async (): Promise<SandboxMetrics> => {
        const units = await source.units();
        const at = source.now();
        const daemon = source.daemon();
        const [scanned, cgroup, disk] = await Promise.all([scan(daemon.pid), readCgroup(source.readText), source.disk(workspaceRoot)]);
        const samples = scanned.map((entry) => ({
            owner: entry.owner,
            role: entry.role,
            rssBytes: (entry.rssPages ?? 0) * units.pageBytes,
            ticks: (entry.cpuTicks ?? 0) + (entry.childCpuTicks ?? 0),
        }));
        const totals = totalsOf(samples);
        const now: Baseline = {
            at,
            ownerTicks: new Map([...totals.owners].map(([owner, total]) => [owner, total.ticks])),
            processTicks: totals.ticks,
            cgroupCpuMicros: cgroup.cpuUsageMicros,
            daemon,
        };
        const since = measurableFrom(baseline, at);
        baseline = now;
        const windowMs = since === undefined ? undefined : at - since.at;
        return {
            at,
            ...(windowMs === undefined ? {} : { windowMs }),
            sandbox: sandboxUsageOf({
                cgroup,
                machine: source.machine(),
                disk,
                // The daemon is running too, and is the one process the scan leaves out.
                processes: samples.length + 1,
                coresUsed: since === undefined ? undefined : sandboxCpuMs(now, since, units.ticksPerSecond) / (at - since.at),
            }),
            daemon: daemonUsageOf(daemon, since?.daemon, windowMs),
            sessions: sessionsOf(totals, since?.ownerTicks, windowMs, units.ticksPerSecond),
            roles: totals.roles,
        };
    };

    return {
        read: () => {
            if (inFlight !== undefined) {
                return inFlight;
            }
            if (last !== undefined && source.now() - last.at < REUSE_MS) {
                return Promise.resolve(last);
            }
            inFlight = sample()
                .then((metrics) => {
                    last = metrics;
                    return metrics;
                })
                .finally(() => {
                    inFlight = undefined;
                });
            return inFlight;
        },
    };
};
