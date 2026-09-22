import { readdir, readFile, statfs } from "node:fs/promises";
import { availableParallelism, endianness, freemem, loadavg, totalmem } from "node:os";
import { performance } from "node:perf_hooks";
import { mapPool } from "@intentic/base/async";
import type {
    DaemonUsage,
    PressureMetrics,
    ProcessGroupMetrics,
    ProcessRole,
    SandboxMetrics,
    SandboxUsage,
    SessionMetrics,
} from "@intentic/sandbox-contract";
import { DAEMON_OWNER, ONE_SHOT_OWNER, ownerOf } from "../boot/leftovers.js";
import { parsePressure } from "./loop-watchdog.js";
import { type ParsedProcStat, parseProcStat } from "./proc-stat.js";
import { classifyProcess } from "./resource-metrics.js";

// GET /system/metrics: CPU and memory per conversation, per kind of process, and for the sandbox. Runs only inside a
// request and holds no timer; between requests it keeps the counters the next CPU figure is measured from, and what
// each live process was found to be, which is read once in the process's life.

// Requests closer together than this share one reading, so several open boards cost what one does.
const REUSE_MS = 1_000;
// A baseline older than this would average a spell nobody watched, so the reading after it carries no CPU figures.
const BASELINE_MAX_AGE_MS = 10_000;
// procfs reads in flight at once: a scan still takes milliseconds, and the daemon's other file work never queues
// behind hundreds of them.
const READ_CONCURRENCY = 8;
const CGROUP = "/sys/fs/cgroup";

// Owners that are pools rather than conversations (platform/boot/leftovers.ts): counted by kind of process only.
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

// What /proc/<pid>/stat counts in: bytes per page for `rss`, clock ticks per second for the CPU times.
export interface ProcUnits {
    readonly pageBytes: number;
    readonly ticksPerSecond: number;
}

export interface DiskReading {
    readonly usedBytes: number;
    readonly totalBytes: number;
}

// Everything a reading touches outside this module: the real procfs, cgroup and process unless a test hands in a fake.
export interface LiveMetricsSource {
    readonly listPids: () => Promise<readonly number[]>;
    // One procfs or cgroup file; undefined when it is gone, forbidden, or absent on this kernel.
    readonly readText: (path: string) => Promise<string | undefined>;
    readonly disk: (path: string) => Promise<DiskReading | undefined>;
    readonly units: () => Promise<ProcUnits>;
    readonly daemon: () => DaemonReading;
    readonly machine: () => MachineReading;
    // Epoch milliseconds.
    readonly now: () => number;
}

// USER_HZ and the page size on every platform this daemon ships for; used only when auxv cannot be read.
const DEFAULT_UNITS: ProcUnits = { pageBytes: 4096, ticksPerSecond: 100 };
const AT_PAGESZ = 6n;
const AT_CLKTCK = 17n;

// The auxiliary vector the kernel handed this process: pairs of 64-bit words, type then value, in native byte order.
export const parseAuxv = (auxv: Buffer, littleEndian: boolean): ProcUnits => {
    const entries = new Map<bigint, bigint>();
    for (let at = 0; at + 16 <= auxv.length; at += 16) {
        entries.set(
            littleEndian ? auxv.readBigUInt64LE(at) : auxv.readBigUInt64BE(at),
            littleEndian ? auxv.readBigUInt64LE(at + 8) : auxv.readBigUInt64BE(at + 8),
        );
    }
    const pageBytes = Number(entries.get(AT_PAGESZ) ?? 0n);
    const ticksPerSecond = Number(entries.get(AT_CLKTCK) ?? 0n);
    return {
        pageBytes: pageBytes > 0 ? pageBytes : DEFAULT_UNITS.pageBytes,
        ticksPerSecond: ticksPerSecond > 0 ? ticksPerSecond : DEFAULT_UNITS.ticksPerSecond,
    };
};

const NUMERIC = /^\d+$/u;

const procSource = (): LiveMetricsSource => {
    let units: Promise<ProcUnits> | undefined;
    return {
        listPids: async () =>
            (await readdir("/proc").catch(() => [] as string[])).filter((entry) => NUMERIC.test(entry)).map(Number),
        readText: (path) => readFile(path, "utf8").catch(() => undefined),
        disk: (path) =>
            statfs(path)
                .then((volume) => ({ usedBytes: (volume.blocks - volume.bfree) * volume.bsize, totalBytes: volume.blocks * volume.bsize }))
                .catch(() => undefined),
        units: () =>
            (units ??= readFile("/proc/self/auxv")
                .then((auxv) => parseAuxv(auxv, endianness() === "LE"))
                .catch(() => DEFAULT_UNITS)),
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
    };
};

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

// The cgroup v2 files the sandbox's own totals come from; each is undefined where the kernel or runtime lacks it.
export interface CgroupFiles {
    readonly cpuStat: string | undefined;
    readonly cpuMax: string | undefined;
    readonly memoryCurrent: string | undefined;
    readonly memoryMax: string | undefined;
    readonly memoryStat: string | undefined;
    readonly swapCurrent: string | undefined;
    readonly pressure: { readonly cpu: string | undefined; readonly memory: string | undefined; readonly io: string | undefined };
}

// A single-number cgroup file; `max`, empty and unreadable all mean no value.
const numeric = (text: string | undefined): number | undefined => {
    const trimmed = text?.trim();
    if (trimmed === undefined || !NUMERIC.test(trimmed)) {
        return undefined;
    }
    return Number(trimmed);
};

// One `key value` line of a flat-keyed cgroup file such as cpu.stat or memory.stat.
export const keyedValue = (text: string | undefined, key: string): number | undefined => {
    const value = new RegExp(`^${key} (\\d+)$`, "mu").exec(text ?? "")?.[1];
    return value === undefined ? undefined : Number(value);
};

// `max 100000` is no quota; `150000 100000` is one and a half cores.
export const quotaCores = (cpuMax: string | undefined): number | undefined => {
    const [quota, period] = (cpuMax ?? "").trim().split(/\s+/u);
    const cores = Number(quota) / Number(period);
    return Number.isFinite(cores) && cores > 0 ? cores : undefined;
};

const pressureOf = (texts: CgroupFiles["pressure"]): PressureMetrics | undefined => {
    const [cpu, memory, io] = [texts.cpu, texts.memory, texts.io].map((text) => (text === undefined ? undefined : parsePressure(text)?.some));
    return cpu === undefined || memory === undefined || io === undefined ? undefined : { cpu, memory, io };
};

export interface SandboxUsageInput {
    readonly cgroup: CgroupFiles;
    readonly machine: MachineReading;
    readonly disk: DiskReading | undefined;
    readonly processes: number;
    // CPU the sandbox used over the window, in cores; undefined on a first reading.
    readonly coresUsed: number | undefined;
}

// Memory is the working set: current use less the inactive file cache the kernel reclaims first, which is what runs
// into the limit. Capacity is the quota where there is one, and never more than the cores the sandbox can be given.
export const sandboxUsageOf = ({ cgroup, machine, disk, processes, coresUsed }: SandboxUsageInput): SandboxUsage => {
    const cores = Math.min(quotaCores(cgroup.cpuMax) ?? Number.POSITIVE_INFINITY, machine.cores);
    const current = numeric(cgroup.memoryCurrent);
    const swap = numeric(cgroup.swapCurrent);
    const pressure = pressureOf(cgroup.pressure);
    return {
        ...(coresUsed === undefined ? {} : { cpuPercent: roundTenth((coresUsed / cores) * 100) }),
        cores,
        memoryBytes:
            current === undefined
                ? Math.max(0, machine.totalMemoryBytes - machine.freeMemoryBytes)
                : Math.max(0, current - (keyedValue(cgroup.memoryStat, "inactive_file") ?? 0)),
        memoryLimitBytes: Math.min(numeric(cgroup.memoryMax) ?? Number.POSITIVE_INFINITY, machine.totalMemoryBytes),
        ...(swap === undefined ? {} : { swapBytes: swap }),
        ...(disk === undefined ? {} : { diskBytes: disk.usedBytes, diskTotalBytes: disk.totalBytes }),
        loadAverage: [...machine.loadAverage],
        processes,
        ...(pressure === undefined ? {} : { pressure }),
    };
};

export const daemonUsageOf = (now: DaemonReading, before: DaemonReading | undefined, windowMs: number | undefined): DaemonUsage => {
    const loopMs = before === undefined ? 0 : now.loopActiveMs + now.loopIdleMs - (before.loopActiveMs + before.loopIdleMs);
    return {
        rssBytes: now.rssBytes,
        heapUsedBytes: now.heapUsedBytes,
        ...(before === undefined || windowMs === undefined ? {} : { cpuPercent: roundTenth(((now.cpuMicros - before.cpuMicros) / 1000 / windowMs) * 100) }),
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

// What a process was found to be. `key` is its start time and comm, so a new process on a reused pid, or an exec that
// renamed this one, is identified again.
interface Identity {
    readonly key: string;
    readonly owner: string | undefined;
    readonly role: ProcessRole;
}

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
    const identities = new Map<number, Identity>();
    let baseline: Baseline | undefined;
    let last: SandboxMetrics | undefined;
    let inFlight: Promise<SandboxMetrics> | undefined;

    // environ, cmdline and cgroup are fixed at exec, so they are read on first sight rather than on every scan.
    const identify = async (pid: number, stat: ParsedProcStat): Promise<Identity> => {
        const key = `${stat.startTimeTicks ?? ""}:${stat.comm}`;
        const known = identities.get(pid);
        if (known?.key === key) {
            return known;
        }
        const [environ, cmdline, cgroup] = await Promise.all([
            source.readText(`/proc/${pid}/environ`),
            source.readText(`/proc/${pid}/cmdline`),
            source.readText(`/proc/${pid}/cgroup`),
        ]);
        const identity = {
            key,
            owner: environ === undefined ? undefined : ownerOf(environ),
            role: classifyProcess(`${stat.comm} ${(cmdline ?? "").replaceAll("\0", " ")}`, cgroup ?? ""),
        };
        identities.set(pid, identity);
        return identity;
    };

    const scan = async (daemonPid: number, pageBytes: number): Promise<ProcessSample[]> => {
        const pids = (await source.listPids()).filter((pid) => pid !== daemonPid);
        const samples: ProcessSample[] = [];
        const alive = new Set<number>();
        await mapPool(pids, READ_CONCURRENCY, async (pid) => {
            const text = await source.readText(`/proc/${pid}/stat`);
            const stat = text === undefined ? undefined : parseProcStat(text);
            // Exited between the listing and the read, the ordinary case during a scan.
            if (stat?.cpuTicks === undefined) {
                return;
            }
            const { owner, role } = await identify(pid, stat);
            alive.add(pid);
            samples.push({ owner, role, rssBytes: (stat.rssPages ?? 0) * pageBytes, ticks: stat.cpuTicks + (stat.childCpuTicks ?? 0) });
        });
        for (const pid of identities.keys()) {
            if (!alive.has(pid)) {
                identities.delete(pid);
            }
        }
        return samples;
    };

    const pressureText = async (kind: "cpu" | "memory" | "io"): Promise<string | undefined> =>
        (await source.readText(`${CGROUP}/${kind}.pressure`)) ?? source.readText(`/proc/pressure/${kind}`);

    const readCgroup = async (): Promise<CgroupFiles> => {
        const [cpuStat, cpuMax, memoryCurrent, memoryMax, memoryStat, swapCurrent, cpu, memory, io] = await Promise.all([
            source.readText(`${CGROUP}/cpu.stat`),
            source.readText(`${CGROUP}/cpu.max`),
            source.readText(`${CGROUP}/memory.current`),
            source.readText(`${CGROUP}/memory.max`),
            source.readText(`${CGROUP}/memory.stat`),
            source.readText(`${CGROUP}/memory.swap.current`),
            pressureText("cpu"),
            pressureText("memory"),
            pressureText("io"),
        ]);
        return { cpuStat, cpuMax, memoryCurrent, memoryMax, memoryStat, swapCurrent, pressure: { cpu, memory, io } };
    };

    const sample = async (): Promise<SandboxMetrics> => {
        const units = await source.units();
        const at = source.now();
        const daemon = source.daemon();
        const [samples, cgroup, disk] = await Promise.all([scan(daemon.pid, units.pageBytes), readCgroup(), source.disk(workspaceRoot)]);
        const totals = totalsOf(samples);
        const now: Baseline = {
            at,
            ownerTicks: new Map([...totals.owners].map(([owner, total]) => [owner, total.ticks])),
            processTicks: totals.ticks,
            cgroupCpuMicros: keyedValue(cgroup.cpuStat, "usage_usec"),
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
