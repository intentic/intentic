import { readdirSync, readFileSync } from "node:fs";

// CPU time off /proc, the way voxl's bench/cpu.sh reads it: utime + stime of every thread of a process, in clock ticks.

export interface ProcStat {
    readonly pid: number;
    readonly comm: string;
    readonly ppid: number;
    // utime + stime, every thread of the process.
    readonly ticks: number;
    // cutime + cstime: what its children that exited and were reaped had spent.
    readonly reapedTicks: number;
}

// One /proc/<pid>/stat line. The command name is in parentheses and may itself hold spaces and parentheses, so the
// fields are counted from the last closing one.
export const parseStat = (line: string): ProcStat | undefined => {
    const open = line.indexOf("(");
    const close = line.lastIndexOf(")");
    if (open < 0 || close < open) {
        return undefined;
    }
    // After the name: state (field 3), ppid (4), … utime (14), stime (15).
    const rest = line
        .slice(close + 2)
        .trim()
        .split(/\s+/u);
    const ppid = Number(rest[1]);
    const utime = Number(rest[11]);
    const stime = Number(rest[12]);
    const cutime = Number(rest[13]);
    const cstime = Number(rest[14]);
    if (![ppid, utime, stime, cutime, cstime].every(Number.isFinite)) {
        return undefined;
    }
    return { pid: Number(line.slice(0, open).trim()), comm: line.slice(open + 1, close), ppid, ticks: utime + stime, reapedTicks: cutime + cstime };
};

export const readStat = (pid: number): ProcStat | undefined => {
    try {
        return parseStat(readFileSync(`/proc/${pid}/stat`, "utf8"));
    } catch {
        // allow(silent-catch): the process is gone, which reads as no process.
        return undefined;
    }
};

const allStats = (): ProcStat[] =>
    readdirSync("/proc")
        .filter((entry) => /^\d+$/u.test(entry))
        .map((entry) => readStat(Number(entry)))
        .filter((stat): stat is ProcStat => stat !== undefined);

// Every process under `root`, `root` included.
export const processTree = (root: number): ProcStat[] => {
    const stats = allStats();
    const tree: ProcStat[] = [];
    const wanted = new Set([root]);
    let grew = true;
    while (grew) {
        grew = false;
        for (const stat of stats) {
            if (!wanted.has(stat.pid) && wanted.has(stat.ppid)) {
                wanted.add(stat.pid);
                grew = true;
            }
        }
    }
    for (const stat of stats) {
        if (wanted.has(stat.pid)) {
            tree.push(stat);
        }
    }
    return tree;
};

// This process's children running `comm`: the encoders the legacy pipeline starts, one per viewer and one more per
// restart.
export const childrenNamed = (comm: string, parent = process.pid): number[] =>
    allStats()
        .filter((stat) => stat.ppid === parent && stat.comm === comm)
        .map((stat) => stat.pid);

// The processes running `comm` whose command line holds `arg`: a browser told apart from another by its profile dir.
export const processesWithArg = (comm: string, arg: string): number[] =>
    allStats()
        .filter((stat) => stat.comm === comm)
        .filter((stat) => {
            try {
                return readFileSync(`/proc/${stat.pid}/cmdline`, "utf8").split("\0").some((part) => part.includes(arg));
            } catch {
                // allow(silent-catch): gone between the listing and the read, so not one of them.
                return false;
            }
        })
        .map((stat) => stat.pid);

// The CPU a set of processes had spent at one moment, and what this process's reaped children had spent in all.
export interface TickSnapshot {
    readonly ticks: ReadonlyMap<number, number>;
    readonly reaped: number;
}

export const snapshotTicks = (pids: readonly number[]): TickSnapshot => {
    const ticks = new Map<number, number>();
    for (const pid of pids) {
        const stat = readStat(pid);
        if (stat !== undefined) {
            ticks.set(pid, stat.ticks);
        }
    }
    return { ticks, reaped: readStat(process.pid)?.reapedTicks ?? 0 };
};

// The ticks spent between two snapshots, taken before and after a window, with nothing read in between, so metering
// costs the measured processes nothing. Each process alive at the end counts from its first reading, or from zero when
// it started inside the window. With `reaped`, the processes are this one's children and one that exited inside the
// window (an encoder restarted for a keyframe) is counted too: the kernel adds a reaped child's whole time to its
// parent's, and the part it had spent before the window is taken back off.
export const ticksBetween = (before: TickSnapshot, after: TickSnapshot, reaped: boolean): number => {
    let total = 0;
    for (const [pid, ticks] of after.ticks) {
        total += ticks - (before.ticks.get(pid) ?? 0);
    }
    if (reaped) {
        total += after.reaped - before.reaped;
        for (const [pid, ticks] of before.ticks) {
            if (!after.ticks.has(pid)) {
                total -= ticks;
            }
        }
    }
    return total;
};
