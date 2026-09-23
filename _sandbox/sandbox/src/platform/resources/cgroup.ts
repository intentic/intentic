import { readFile } from "node:fs/promises";

// The sandbox's own cgroup v2 figures; /proc/pressure describes the host and stands in only where the cgroup keeps none.

const CGROUP = "/sys/fs/cgroup";
const PRESSURE_KINDS = ["cpu", "memory", "io"] as const;

// One procfs or cgroup file; undefined when it is gone, forbidden, or absent on this kernel.
export type ReadText = (path: string) => Promise<string | undefined>;
export const readText: ReadText = (path) => readFile(path, "utf8").catch(() => undefined);

// One PSI file reduced to avg10, in percent, of `some` (anything stalled) and `full` (everything stalled).
export interface PressureSnapshot {
    readonly some: number;
    readonly full: number;
}
export type Pressure = Readonly<Record<(typeof PRESSURE_KINDS)[number], PressureSnapshot | undefined>>;

const avg10 = (line: string | undefined): number | undefined => {
    const value = line?.match(/avg10=([0-9.]+)/)?.[1];
    return value === undefined ? undefined : Number(value);
};

export const parsePressure = (text: string): PressureSnapshot | undefined => {
    const lines = text.split("\n");
    const some = avg10(lines.find((line) => line.startsWith("some")));
    if (some === undefined) {
        return undefined;
    }
    // `full` is absent for CPU (a runnable task always makes progress on something); reported as 0.
    return { some, full: avg10(lines.find((line) => line.startsWith("full"))) ?? 0 };
};

export const readPressure = async (read: ReadText = readText): Promise<Pressure> => {
    const [cpu, memory, io] = await Promise.all(
        PRESSURE_KINDS.map(async (kind) => {
            const text = (await read(`${CGROUP}/${kind}.pressure`)) ?? (await read(`/proc/pressure/${kind}`));
            return text === undefined ? undefined : parsePressure(text);
        }),
    );
    return { cpu, memory, io };
};

// A single-number file; `max`, empty and unreadable all mean no value.
const numeric = (text: string | undefined): number | undefined => {
    const trimmed = text?.trim() ?? "";
    return /^\d+$/u.test(trimmed) ? Number(trimmed) : undefined;
};

// Every `key value` line of a flat-keyed file (cpu.stat, memory.stat, memory.events, meminfo less its units).
export const flatKeyed = (text: string | undefined): Record<string, number> =>
    Object.fromEntries(
        (text ?? "")
            .trim()
            .split("\n")
            .map((line) => line.trim().split(/\s+/u))
            .filter((parts): parts is [string, string] => parts.length === 2 && Number.isFinite(Number(parts[1])))
            .map(([key, value]) => [key.replace(/:$/u, ""), Number(value)]),
    );

export interface CgroupReading {
    // cpu.stat's usage_usec: CPU the whole cgroup has used, in microseconds.
    readonly cpuUsageMicros: number | undefined;
    // What the quota took back since the cgroup began: scheduling periods stopped, and time stopped.
    readonly cpuThrottle: { readonly throttledMs: number; readonly throttledPeriods: number } | undefined;
    // cpu.max as cores; undefined when there is no quota.
    readonly cpuQuotaCores: number | undefined;
    // memory.current: the resident charge, file cache included and swapped pages not.
    readonly memoryBytes: number | undefined;
    // memory.current less the inactive file cache the kernel reclaims first: "memory used", the figure that meets the limit.
    readonly workingSetBytes: number | undefined;
    // memory.max; undefined when uncapped.
    readonly memoryLimitBytes: number | undefined;
    // memory.swap.current: anon pushed to swap, charged here and not to memory.current.
    readonly swapBytes: number | undefined;
    readonly swapLimitBytes: number | undefined;
    // memory.events' cumulative counters: oom_kill, oom_group_kill, max, high.
    readonly memoryEvents: Readonly<Record<string, number>>;
    readonly pressure: Pressure;
}

export const readCgroup = async (read: ReadText = readText): Promise<CgroupReading> => {
    const [cpuStat, cpuMax, current, max, memoryStat, swap, swapMax, events, pressure] = await Promise.all([
        read(`${CGROUP}/cpu.stat`),
        read(`${CGROUP}/cpu.max`),
        read(`${CGROUP}/memory.current`),
        read(`${CGROUP}/memory.max`),
        read(`${CGROUP}/memory.stat`),
        read(`${CGROUP}/memory.swap.current`),
        read(`${CGROUP}/memory.swap.max`),
        read(`${CGROUP}/memory.events`),
        readPressure(read),
    ]);
    const cpu = flatKeyed(cpuStat);
    const throttledUsec = cpu["throttled_usec"];
    const throttledPeriods = cpu["nr_throttled"];
    // `max 100000` is no quota; `150000 100000` is one and a half cores.
    const [quota, period] = (cpuMax ?? "").trim().split(/\s+/u);
    const cores = Number(quota) / Number(period);
    const memoryBytes = numeric(current);
    return {
        cpuUsageMicros: cpu["usage_usec"],
        cpuThrottle:
            throttledUsec === undefined || throttledPeriods === undefined
                ? undefined
                : { throttledMs: Math.round(throttledUsec / 1000), throttledPeriods },
        cpuQuotaCores: Number.isFinite(cores) && cores > 0 ? cores : undefined,
        memoryBytes,
        workingSetBytes: memoryBytes === undefined ? undefined : Math.max(0, memoryBytes - (flatKeyed(memoryStat)["inactive_file"] ?? 0)),
        memoryLimitBytes: numeric(max),
        swapBytes: numeric(swap),
        swapLimitBytes: numeric(swapMax),
        memoryEvents: flatKeyed(events),
        pressure,
    };
};
