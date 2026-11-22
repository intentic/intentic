import { mapPool } from "@intentic/base/async";
import { type ReadText, readText } from "../cgroup.js";
import { listPids, procUnits } from "../process-scan.js";
import { type ParsedProcStat, parseProcStat } from "../proc-stat.js";

/* HOW MUCH MEMORY ONE QUEUED HEAVY COMMAND HELD AT ITS PEAK (2026-11-22, the shinobi-society audit), for the price the
   memory gate gives its next run (command-peaks.ts, @intentic/constants memory-room `learnedCostBytes`). The process
   memory-room names with `--pid` is queue-run itself, which becomes the command at its exec, so everything the command
   starts descends from it: cargo, the rustc and linkers it runs, and the test binary it runs, which is what grew to 13.5
   GB there. The peak is the resident memory of that tree, summed every SAMPLE_MS from the exec until the root exits. A
   process stays in the tree once seen there (by pid and start), so one reparented when its parent exits still counts.
   Not offload/session-memory.ts's session: here an agent's whole command line (its shell, a second command after `;`)
   shares the queued command's session. Pages shared between members count once per member, so the figure errs high.

   Measured in the daemon, never in the wrapper, and never on the command's path: the admission is answered whatever
   happens here, a read that fails measures nothing, and a run that never started (queue-run left without its exec, as a
   skipped deadline does) is never recorded. Linux only. */

const SAMPLE_MS = 2_000;
// procfs reads in flight at once, as the shared process scan reads them.
const READ_CONCURRENCY = 8;

export interface PeakProc {
    readonly listPids: () => Promise<readonly number[]>;
    readonly readText: ReadText;
    readonly pageBytes: () => Promise<number>;
}

const LIVE_PROC: PeakProc = { listPids, readText, pageBytes: async () => (await procUnits()).pageBytes };

export interface PeakWatch {
    // The pid this daemon sees for a process memory-room named by `pid` and `startTicks` from its own pid namespace: the
    // same pid when the two agree, the process with that start whose innermost pid is `pid` for a turn in a namespace of
    // its own, undefined when neither is found.
    readonly resolve: (pid: number, startTicks: number) => Promise<number | undefined>;
    // Measures the tree `pid` leads from now on, once it has exec'd into the command, and records its peak under `key`
    // when it exits. Once per process: a second admission of the same one (a wait asked again) adds nothing.
    readonly watch: (pid: number, key: string, command: string) => Promise<void>;
    // One look now, as the timer takes them.
    readonly look: () => Promise<void>;
    readonly stop: () => void;
}

interface Watched {
    readonly pid: number;
    readonly startTicks: number | undefined;
    readonly key: string;
    readonly command: string;
    // Its argv while it was still queue-run: any other is the command it exec'd into.
    readonly queuedAs: string | undefined;
    started: boolean;
    // Every process found in its tree so far, by pid, with its start.
    members: Map<number, number | undefined>;
    peakBytes: number;
}

// The tree `one` leads in `stats` (every process now, by pid): its root, the members it had that still run as the same
// process, and all their descendants.
const treeOf = (one: Watched, stats: ReadonlyMap<number, ParsedProcStat>, children: ReadonlyMap<number, readonly number[]>): Map<number, number | undefined> => {
    const members = new Map<number, number | undefined>();
    const pending = [one.pid, ...[...one.members].flatMap(([pid, start]) => (stats.get(pid)?.startTimeTicks === start ? [pid] : []))];
    for (let pid = pending.pop(); pid !== undefined; pid = pending.pop()) {
        const stat = stats.get(pid);
        if (stat === undefined || members.has(pid)) {
            continue;
        }
        members.set(pid, stat.startTimeTicks);
        pending.push(...(children.get(pid) ?? []));
    }
    return members;
};

const statOf = async (proc: PeakProc, pid: number): Promise<ParsedProcStat | undefined> => {
    const text = await proc.readText(`/proc/${pid}/stat`);
    return text === undefined ? undefined : parseProcStat(text);
};

const everyStat = async (proc: PeakProc): Promise<Map<number, ParsedProcStat>> => {
    const stats = new Map<number, ParsedProcStat>();
    await mapPool(await proc.listPids(), READ_CONCURRENCY, async (pid) => {
        const stat = await statOf(proc, pid);
        if (stat !== undefined) {
            stats.set(pid, stat);
        }
    });
    return stats;
};

// Each tree's resident memory now, from one scan of every process shared by all of them, raising its peak.
const sampleTrees = async (proc: PeakProc, sampling: readonly Watched[]): Promise<void> => {
    const stats = await everyStat(proc);
    const children = new Map<number, number[]>();
    for (const [pid, stat] of stats) {
        const siblings = children.get(stat.ppid);
        if (siblings === undefined) {
            children.set(stat.ppid, [pid]);
        } else {
            siblings.push(pid);
        }
    }
    const pageBytes = await proc.pageBytes();
    for (const one of sampling) {
        one.members = treeOf(one, stats, children);
        const pages = [...one.members.keys()].reduce((sum, pid) => sum + (stats.get(pid)?.rssPages ?? 0), 0);
        one.peakBytes = Math.max(one.peakBytes, pages * pageBytes);
    }
};

// Where a watched root stands: gone (or its pid taken by another process), still queue-run, or running the command.
const rootState = async (proc: PeakProc, one: Watched): Promise<"ended" | "queued" | "running"> => {
    const stat = await statOf(proc, one.pid);
    if (stat === undefined || stat.startTimeTicks !== one.startTicks) {
        return "ended";
    }
    if (!one.started) {
        const argv = await proc.readText(`/proc/${one.pid}/cmdline`);
        one.started = argv !== undefined && argv !== one.queuedAs;
    }
    return one.started ? "running" : "queued";
};

// PeakWatch["resolve"].
const resolvePid = async (proc: PeakProc, pid: number, startTicks: number): Promise<number | undefined> => {
    if ((await statOf(proc, pid))?.startTimeTicks === startTicks) {
        return pid;
    }
    const candidates = [...(await everyStat(proc))].flatMap(([candidate, stat]) => (stat.startTimeTicks === startTicks ? [candidate] : []));
    for (const candidate of candidates) {
        const innermost = /^NSpid:\s+(.+)$/mu.exec((await proc.readText(`/proc/${candidate}/status`)) ?? "")?.[1]?.trim().split(/\s+/u).at(-1);
        if (Number(innermost) === pid) {
            return candidate;
        }
    }
    return undefined;
};

export const createPeakWatch = ({
    record,
    proc = LIVE_PROC,
    sampleMs = SAMPLE_MS,
}: {
    readonly record: (key: string, command: string, peakBytes: number) => Promise<void>;
    readonly proc?: PeakProc;
    // 0 takes no timed looks: only `look` does.
    readonly sampleMs?: number;
}): PeakWatch => {
    const watched = new Map<number, Watched>();
    let timer: ReturnType<typeof setInterval> | undefined;
    let looking: Promise<void> | undefined;

    const stopTimer = (): void => {
        clearInterval(timer);
        timer = undefined;
    };

    // A root that ended is let go, and its peak recorded if it ran the command at all.
    const finish = async (one: Watched): Promise<void> => {
        watched.delete(one.pid);
        if (one.started && one.peakBytes > 0) {
            // allow(silent-catch): a peak that cannot be written is a run the next one measures again
            await record(one.key, one.command, one.peakBytes).catch(() => undefined);
        }
    };

    const lookNow = async (): Promise<void> => {
        const states = await Promise.all([...watched.values()].map(async (one) => [one, await rootState(proc, one)] as const));
        const sampling = states.flatMap(([one, state]) => (state === "running" ? [one] : []));
        if (sampling.length > 0) {
            await sampleTrees(proc, sampling);
        }
        await Promise.all(states.flatMap(([one, state]) => (state === "ended" ? [finish(one)] : [])));
        if (watched.size === 0) {
            stopTimer();
        }
    };

    const look = (): Promise<void> =>
        (looking ??= lookNow()
            // allow(silent-catch): a look that fails measures nothing this time; the next one reads everything again
            .catch(() => undefined)
            .finally(() => {
                looking = undefined;
            }));

    return {
        resolve: (pid, startTicks) => resolvePid(proc, pid, startTicks),
        watch: async (pid, key, command) => {
            if (watched.has(pid)) {
                return;
            }
            const [stat, queuedAs] = await Promise.all([statOf(proc, pid), proc.readText(`/proc/${pid}/cmdline`)]);
            if (stat === undefined || watched.has(pid)) {
                return;
            }
            watched.set(pid, { pid, startTicks: stat.startTimeTicks, key, command, queuedAs, started: false, members: new Map(), peakBytes: 0 });
            if (timer === undefined && sampleMs > 0) {
                timer = setInterval(() => void look(), sampleMs);
                timer.unref();
            }
        },
        look,
        stop: () => {
            stopTimer();
            watched.clear();
        },
    };
};
