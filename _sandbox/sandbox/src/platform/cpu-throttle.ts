import { readFileSync } from "node:fs";

/* HOW MUCH OF THIS MACHINE'S TIME THE HOST TOOK BACK, off the cgroup's own counters.
 *
 * A hosted sandbox runs on shared vCPUs with a quota (Fly's: 6.25% of a core per vCPU, sustained, after a few
 * seconds of burst), and a first boot that copies a tree, hashes it into git and starts a dev server spends the
 * burst in its first seconds and crawls for the rest. From inside, that looks exactly like a slow daemon: every
 * step takes eight times longer and nothing says why. These two numbers say why. `nr_throttled` is how many
 * scheduling periods this cgroup was stopped for exceeding its quota; `throttled_usec` is the time it spent
 * stopped. Both are cumulative since the machine started, which for a hosted machine is since this boot.
 *
 * Read from the cgroup and not from /proc, for the reason memory-admission.ts gives about memory: /proc reports
 * the HOST. Undefined where there is no cgroup v2 to read (a dev daemon on macOS, a test), and "not throttled"
 * is never inferred from an unreadable file. */

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
