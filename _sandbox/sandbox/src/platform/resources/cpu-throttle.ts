import { readFileSync } from "node:fs";

// How much of this machine's CPU time the host took back, off the cgroup's own counters: nr_throttled scheduling
// periods stopped, throttled_usec cumulative time stopped, both since this boot. Read from the cgroup, not /proc, since
// /proc reports the host; undefined where there is no cgroup v2 to read.

const CPU_STAT = "/sys/fs/cgroup/cpu.stat";

export interface CpuThrottle {
    readonly throttledMs: number;
    readonly throttledPeriods: number;
}

export const parseCpuStat = (text: string): CpuThrottle | undefined => {
    const fields = new Map<string, number>();
    for (const line of text.split("\n")) {
        const [key, value] = line.trim().split(/\s+/);
        if (key !== undefined && value !== undefined && Number.isFinite(Number(value))) {
            fields.set(key, Number(value));
        }
    }
    const periods = fields.get("nr_throttled");
    const usec = fields.get("throttled_usec");
    return periods === undefined || usec === undefined ? undefined : { throttledMs: Math.round(usec / 1000), throttledPeriods: periods };
};

export const readCpuThrottle = (path: string = CPU_STAT): CpuThrottle | undefined => {
    try {
        return parseCpuStat(readFileSync(path, "utf8"));
    } catch {
        return undefined;
    }
};
