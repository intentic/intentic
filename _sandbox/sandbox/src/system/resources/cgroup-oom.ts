import { closeSync, constants, type FSWatcher, openSync, readSync, watch } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Logger } from "pino";
import { opt } from "../../opt.js";
import { flatKeyed, parsePressure, type ReadText, readText } from "./cgroup.js";
import { workloadLeafOf } from "./daemon-cgroup.js";
import { type KernelLine, type KernelOomKill, kernelLinesOf, oomKillsOf, residentBytesOf } from "./kernel-oom-lines.js";
import type { MemoryKill, Psi } from "./memory-records.js";
import { parseProcStat } from "./proc-stat.js";

/* WHO THE KERNEL KILLED IN THE WORKLOAD LEAF, AND WHOSE IT WAS (2026-11-05). With the workload leaf bounded
   (docker-entrypoint.sh, daemon-cgroup.ts), a runaway now meets the leaf's own OOM in under a minute instead of paging the
   machine for two hours; but a kill the kernel makes leaves only a counter going up in `memory.events` and a line in the
   kernel's log naming a pid from the VM's namespace, not the container's. The conversation whose process it was would
   learn nothing, as it learned nothing on the day. So on every sampler tick, and the moment the counter moves (cgroup2
   notifies a change to memory.events), the victim is named from the kernel's log and joined with what the last process
   scan knew of it: its owner stamp, its background job, its argv, its resident and swapped bytes. That joined fact is a
   `cgroup-oom` line in memory-kills.jsonl, the file netd's own memory guard writes its kills to, which the daemon follows
   to tell the job and the conversation (agent/tools/jobs/memory-kills.ts) and the next boot's post-mortem reads.

   The kernel's lines are read by kernel-oom-lines.ts, the parser the boot's post-mortem reads them with too. They name the
   pid as the VM sees it, so it is matched by the process's name (comm, which is the same 15 characters everywhere) among
   the processes the last scan saw that are gone now, the closest in size first. A look can come between a kill's two
   lines (the leaf's counter moves before the kernel prints its `Killed process` line), and the `oom-kill:` line alone
   still names the victim and its cgroup. */

const KIB = 1024;

/** The kernel's log, line by line from where the last read stopped, never blocking; undefined where it cannot be read. */
export type KernelLog = () => readonly KernelLine[] | undefined;

// Every record a nonblocking reader is handed is one read(2), and a ring holds a few thousand: the bound only keeps a
// kernel that never says EAGAIN from holding the loop.
const MOST_RECORDS = 20_000;

export interface KernelLogReader {
    readonly read: KernelLog;
    readonly close: () => void;
}

// One read(2) of the log: a record's lines (none for a record that is not a dated line), the end of what there is
// (`end`: EAGAIN from /dev/kmsg, 0 from anything standing in for it), or a reader that cannot go on (`broken`). EPIPE,
// the ring having overwritten records this reader had not read yet, reads as no lines: the next read goes on from the
// oldest one kept.
const readOne = (fd: number, buffer: Buffer): readonly KernelLine[] | "end" | "broken" => {
    try {
        const length = readSync(fd, buffer, 0, buffer.length, null);
        return length === 0 ? "end" : kernelLinesOf(buffer.toString("utf8", 0, length));
    } catch (error) {
        // SAFETY: readSync throws only the errno errors of read(2), each carrying its code.
        const code = (error as NodeJS.ErrnoException).code;
        return code === "EPIPE" ? [] : code === "EAGAIN" ? "end" : "broken";
    }
};

/** /dev/kmsg, opened once and read to its end on every call: the first call drains what was there before. */
export const openKernelLog = (path = "/dev/kmsg"): KernelLogReader => {
    let fd: number | undefined;
    let unreadable = false;
    const buffer = Buffer.alloc(16 * KIB);
    const read: KernelLog = () => {
        try {
            fd ??= unreadable ? undefined : openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
        } catch {
            // allow(silent-catch): a container without CAP_SYSLOG or /dev/kmsg is one where kills are told by the processes that vanished instead.
            unreadable = true;
        }
        if (fd === undefined) {
            return undefined;
        }
        const lines: KernelLine[] = [];
        for (let reads = 0; reads < MOST_RECORDS; reads += 1) {
            const one = readOne(fd, buffer);
            if (one === "end") {
                break;
            }
            if (one === "broken") {
                unreadable = true;
                closeSync(fd);
                fd = undefined;
                return undefined;
            }
            lines.push(...one);
        }
        return lines;
    };
    return {
        read,
        close: () => {
            if (fd !== undefined) {
                closeSync(fd);
                fd = undefined;
            }
        },
    };
};

// What the last scan knew of a process, for naming the one the kernel killed after it is gone.
export interface KnownProcess {
    readonly pid: number;
    readonly name: string;
    readonly owner?: string | undefined;
    readonly jobId?: string | undefined;
    readonly argv?: string | undefined;
    readonly pgrp: number;
    readonly rssBytes: number;
    readonly rssHighWaterBytes: number;
    readonly swapBytes: number;
    readonly startTimeTicks?: number | undefined;
}

/** What the detector keeps of one of the sampler's rows (resource-metrics.ts ProcessRow). */
export const knownOf = (row: {
    readonly pid: number;
    readonly name: string;
    readonly owner?: string | undefined;
    readonly jobId?: string | undefined;
    readonly argv?: string | undefined;
    readonly pgrp?: number | undefined;
    readonly rssBytes: number;
    readonly rssHighWaterBytes?: number | undefined;
    readonly swapBytes: number;
    readonly startTimeTicks?: number | undefined;
}): KnownProcess => ({ ...row, pgrp: row.pgrp ?? row.pid, rssHighWaterBytes: row.rssHighWaterBytes ?? row.rssBytes });

const GIB = 1024 ** 3;
const sized = (bytes: number | undefined): string => (bytes === undefined ? "no bound" : `${(bytes / GIB).toFixed(1)} GiB`);
const numeric = (text: string | undefined): number | undefined => (/^\d+$/u.test((text ?? "").trim()) ? Number((text ?? "").trim()) : undefined);

// When the kernel made the kill, from its microseconds since boot and /proc/uptime; the moment it was seen where the two
// clocks disagree past reason (a VM that slept counts the sleep in one and not the other).
const killedAt = (usec: number, uptime: string | undefined, now: number, notBefore: number): number => {
    const upMs = Number((uptime ?? "").split(/\s+/u)[0]) * 1000;
    const at = Math.round(now - (upMs - usec / 1000));
    return Number.isFinite(at) && at <= now && at >= notBefore ? at : now;
};

// What one look found, for naming its kills: the kernel's lines since the last look (undefined where the log cannot be
// read), how far the counter moved, the processes the last scan saw that are gone now, and the leaf's state for the reason.
export interface LookFacts {
    readonly leaf: string;
    readonly lines: readonly KernelLine[] | undefined;
    readonly counted: number;
    readonly vanished: readonly KnownProcess[];
    readonly bounds: string;
    readonly psi: Psi | undefined;
    readonly at: (usec: number) => number;
    readonly now: number;
}

// What the scan knew of the victim: its own pid (the container's, where the kernel's is the VM's), its stamp and job.
const processFacts = (process: KnownProcess) => ({
    pid: process.pid,
    comm: process.name,
    ...opt("argv", process.argv),
    rssBytes: Math.max(process.rssHighWaterBytes, process.rssBytes),
    swapBytes: process.swapBytes,
    pgid: process.pgrp,
    ...opt("owner", process.owner),
    ...opt("jobId", process.jobId),
});

// The closest in size of the vanished processes of this name (the largest, where the kernel gave no size), taken out of
// the running for the kills after it.
const takeVanished = (vanished: KnownProcess[], comm: string, rssBytes: number | undefined): KnownProcess | undefined => {
    const size = (process: KnownProcess): number =>
        rssBytes === undefined ? -(process.rssBytes + process.swapBytes) : Math.abs(process.rssBytes + process.swapBytes - rssBytes);
    const best = vanished.filter((process) => process.name === comm).toSorted((left, right) => size(left) - size(right))[0];
    if (best !== undefined) {
        vanished.splice(vanished.indexOf(best), 1);
    }
    return best;
};

const reasonOf = (kill: KernelOomKill, bounds: string): string =>
    kill.scope === "memcg"
        ? `the workload cgroup every agent process runs in reached its bounds (${bounds}), and the kernel killed the process it scored worst`
        : "the machine the sandbox runs on ran out of memory, and the kernel killed the process it scored worst";

/**
 * Every kill one look can name. The kernel's log is the machine's, and another sandbox's workload leaf ends in the same
 * name, so a kill it gives counts as this leaf's when a process the last scan saw here, of that name, is gone; the ones
 * that match nothing here (a process born and killed between two scans, or someone else's) fill only what the leaf's own
 * counter says is left, the newest first. With no log to read, the counter alone says how many, and each is the largest
 * process the last scan saw that is gone now, said as the inference it is.
 */
const nameKills = (facts: LookFacts): MemoryKill[] => {
    const vanished = [...facts.vanished];
    const leafName = facts.leaf.slice(facts.leaf.lastIndexOf("/"));
    const ours = (kill: KernelOomKill): boolean =>
        kill.taskMemcg === undefined || kill.taskMemcg.endsWith(leafName) || kill.taskMemcg.includes(`${leafName}/`);
    const psi = opt("psi", facts.psi);
    const matched = oomKillsOf(facts.lines ?? [])
        .filter(ours)
        .map((kill) => {
            const resident = residentBytesOf(kill);
            return { kill, resident, process: takeVanished(vanished, kill.comm, resident) };
        });
    const known = matched.filter((match) => match.process !== undefined);
    const unknown = matched.filter((match) => match.process === undefined);
    const named: MemoryKill[] = [...known, ...unknown.slice(Math.max(0, unknown.length - (facts.counted - known.length)))].map(({ kill, resident, process }) => {
        const seen = process === undefined ? undefined : Math.max(process.rssHighWaterBytes, process.rssBytes);
        const sizes = [resident, seen].filter((bytes) => bytes !== undefined);
        return {
            at: facts.at(kill.bootUs),
            killer: kill.scope === "global" ? "kernel-oom" : "cgroup-oom",
            ...opt("cgroup", kill.taskMemcg),
            ...(process === undefined ? { pid: kill.pid } : processFacts(process)),
            comm: kill.comm,
            ...opt("rssBytes", sizes.length === 0 ? undefined : Math.max(...sizes)),
            ...psi,
            reason: reasonOf(kill, facts.bounds),
        };
    });
    if (facts.lines !== undefined) {
        return named;
    }
    const largest = vanished.toSorted((left, right) => right.rssBytes + right.swapBytes - (left.rssBytes + left.swapBytes)).slice(0, facts.counted);
    return largest.map((process) => ({
        at: facts.now,
        killer: "cgroup-oom",
        ...processFacts(process),
        ...psi,
        reason: `the workload cgroup every agent process runs in reached its bounds (${facts.bounds}) and the kernel killed a process; the kernel's log could not be read, so this is the largest one gone since the last look`,
    }));
};

export interface OomDetectorDeps {
    // The workload leaf's directory, or undefined where this daemon has none (a local daemon, a guest).
    readonly leaf: () => Promise<string | undefined>;
    readonly read?: ReadText;
    readonly kernelLog: KernelLog;
    readonly record: (kill: MemoryKill) => Promise<void>;
    readonly now?: () => number;
}

export interface OomDetector {
    // A sampler tick: kills since the last look are named against the previous scan, then `processes` becomes what is known.
    readonly observe: (processes: readonly KnownProcess[]) => Promise<readonly MemoryKill[]>;
    // A look between ticks, against the last scan, each process's absence checked in /proc.
    readonly check: () => Promise<readonly MemoryKill[]>;
}

/** Names each kill the workload leaf's OOM made, from the kernel's log and the last scan, and records it. */
export const createOomDetector = (deps: OomDetectorDeps): OomDetector => {
    const read = deps.read ?? readText;
    const now = deps.now ?? Date.now;
    let known = new Map<number, KnownProcess>();
    let counted: number | undefined;
    let lastLookAt = now();
    let queue: Promise<unknown> = Promise.resolve();

    // Gone from this tick's scan, or, between ticks, from /proc (or its pid now someone else's).
    const gone = async (process: KnownProcess, alive: ReadonlySet<number> | undefined): Promise<boolean> => {
        if (alive !== undefined) {
            return !alive.has(process.pid);
        }
        const text = await read(`/proc/${String(process.pid)}/stat`);
        const stat = text === undefined ? undefined : parseProcStat(text);
        return stat === undefined || (process.startTimeTicks !== undefined && stat.startTimeTicks !== process.startTimeTicks);
    };

    const look = async (alive: ReadonlySet<number> | undefined): Promise<readonly MemoryKill[]> => {
        const leaf = await deps.leaf();
        const kills = leaf === undefined ? undefined : flatKeyed(await read(`${leaf}/memory.events`))["oom_kill"];
        if (leaf === undefined || kills === undefined) {
            return [];
        }
        // Read on every look, so the lines a kill is looked for among are only the ones since the last look: the log
        // is the machine's, and another sandbox's kills land in it too.
        const lines = deps.kernelLog();
        const previous = counted;
        const since = lastLookAt;
        counted = kills;
        lastLookAt = now();
        // The first look, and a leaf made again (its counter back at zero), only set where counting starts: what came
        // before is the boot's post-mortem's to name.
        if (previous === undefined || kills <= previous) {
            return [];
        }
        const [memoryMax, swapMax, pressure, uptime] = await Promise.all(
            [`${leaf}/memory.max`, `${leaf}/memory.swap.max`, `${leaf}/memory.pressure`, "/proc/uptime"].map(read),
        );
        const vanished: KnownProcess[] = [];
        for (const process of known.values()) {
            if (await gone(process, alive)) {
                vanished.push(process);
            }
        }
        const psi = pressure === undefined ? undefined : parsePressure(pressure);
        const seenAt = now();
        const named = nameKills({
            leaf,
            lines,
            counted: kills - previous,
            vanished,
            bounds: `memory.max ${sized(numeric(memoryMax))}, swap ${sized(numeric(swapMax))}`,
            psi: psi === undefined ? undefined : { someAvg10: psi.some, fullAvg10: psi.full },
            at: (usec) => killedAt(usec, uptime, seenAt, since),
            now: seenAt,
        });
        for (const kill of named) {
            await deps.record(kill);
        }
        return named;
    };

    // One look at a time, in order: a notification and a tick arriving together must not name one kill twice.
    const serial = (run: () => Promise<readonly MemoryKill[]>): Promise<readonly MemoryKill[]> => {
        const next = queue.then(run, run);
        // allow(silent-catch): the caller of the look that failed is handed its failure; the chain only orders the next look after it.
        queue = next.catch(() => undefined);
        return next;
    };

    return {
        observe: (processes) =>
            serial(async () => {
                const kills = await look(new Set(processes.map((process) => process.pid)));
                known = new Map(processes.map((process) => [process.pid, process]));
                return kills;
            }),
        check: () => serial(() => look(undefined)),
    };
};

/** Appends one kill to memory-kills.jsonl, beside netd's: one write of one line, O_APPEND, as netd writes its own. */
const appendMemoryKill = async (path: string, kill: MemoryKill): Promise<void> => {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(kill)}\n`);
};

/** Looks again the moment the leaf's memory.events changes, which cgroup2 notifies; the sampler's tick covers a miss. */
const watchOomEvents = (leaf: string, look: () => void): (() => void) => {
    let watcher: FSWatcher | undefined;
    try {
        watcher = watch(`${leaf}/memory.events`, { persistent: false }, () => look());
        // allow(silent-catch): a watch that breaks later leaves the minute's tick, which names the same kill a little later.
        watcher.on("error", () => undefined);
    } catch {
        // allow(silent-catch): a cgroup filesystem that cannot be watched leaves the minute's tick, which names the same kill a little later.
        return () => undefined;
    }
    return () => watcher?.close();
};

export interface DaemonOomDetector {
    readonly detector: OomDetector;
    readonly stop: () => void;
}

/** The daemon's own: the workload leaf beside its own, the kernel's log, and `path` (memory-kills.jsonl) beside netd's
 * kills. Each kill is said in the daemon's log too, naming whose it was, beside resource-metrics.ts's counter alarm. */
export const startDaemonOomDetector = (path: string, logger: Pick<Logger, "error">): DaemonOomDetector => {
    const kernelLog = openKernelLog();
    let unwatch: (() => void) | undefined;
    const look = (): void => {
        // allow(silent-catch): a look the notification started that fails leaves the sampler's tick, which looks again within the minute and says its own failure.
        void detector.check().catch(() => undefined);
    };
    const leaf = async (): Promise<string | undefined> => {
        const found = workloadLeafOf((await readText("/proc/self/cgroup")) ?? "");
        // Looked at again the moment the leaf's counter moves, so a kill is named while its job is still ending.
        if (found !== undefined && unwatch === undefined) {
            unwatch = watchOomEvents(found, look);
        }
        return found;
    };
    const detector = createOomDetector({
        leaf,
        kernelLog: kernelLog.read,
        record: async (kill) => {
            logger.error(
                { pid: kill.pid, comm: kill.comm, owner: kill.owner, jobId: kill.jobId, rssBytes: kill.rssBytes, swapBytes: kill.swapBytes, killer: kill.killer },
                "the kernel killed a process in the workload cgroup for memory",
            );
            await appendMemoryKill(path, kill);
        },
    });
    return {
        detector,
        stop: () => {
            unwatch?.();
            kernelLog.close();
        },
    };
};
