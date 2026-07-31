import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import type { Logger } from "pino";

/* The daemon's own stall detector. Every user-visible outage so far has been the event loop going quiet — the
 * /events heartbeat stops, the browser's watchdog trips, and the UI declares the sandbox gone — with nothing
 * in the log to say WHY. The loop can go quiet for three very different reasons, and the fix for each is
 * unrelated to the others:
 *
 *  - in-process: a synchronous path (a runaway regex, a giant JSON.parse, a GC death spiral) is holding the
 *    loop. The daemon's own /proc pressure numbers stay quiet while it happens, and it burns CPU throughout.
 *  - environmental: the whole container is descheduled — the VM is swap-thrashing or IO-saturated under a
 *    fleet of builds/tests/checkouts. PSI (/proc/pressure/*) screams, and no daemon code is at fault.
 *  - a blocking resolver: the main thread is parked in getaddrinfo. Measured here: a lookup the container's
 *    resolver has to forward and never gets answered costs ~8s per attempt, and the loop is dead for all of
 *    it — 16 back-to-back lookups once froze the daemon for 128s. This one looks exactly like the in-process
 *    case (quiet PSI) but burns NO CPU, which is why `dnsInFlight` is reported: PSI answers "is the machine
 *    the problem", CPU-vs-idle answers "is it my own code", and only this says "it is the resolver".
 *
 * A 500ms timer measures its own lateness; a fire that arrives seconds overdue IS the stall, already over.
 * Each stall is logged once with the snapshot taken at recovery, so the log line itself says which of the
 * three worlds the stall came from. Rate-limited: thrash arrives as bursts of stalls, and one line per
 * window carries the same information as fifty. */

const TICK_MS = 500;
// A loop this daemon runs (timers, SSE heartbeats, SDK stream parsing) is never legitimately away this long.
const STALL_THRESHOLD_MS = 1_500;
// One warn per window; a burst's later stalls only bump the counter reported by the next logged one.
const LOG_WINDOW_MS = 10_000;

// One /proc/pressure/<kind> file, reduced to the two numbers that answer "is the machine the problem":
// avg10 of `some` (anything is stalling) and `full` (everything is stalling).
export interface PressureSnapshot {
    readonly some: number;
    readonly full: number;
}

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
    // `full` is absent for CPU (a runnable task always makes progress on something) — report it as 0.
    return { some, full: avg10(lines.find((line) => line.startsWith("full"))) ?? 0 };
};

// PSI is a Linux cgroup2 feature; absent (dev on macOS, old kernels) just means the stall log carries no
// attribution. Sync reads on purpose: procfs pressure files are memory-backed, and this runs once per logged
// stall, not per tick.
const pressure = (kind: "memory" | "cpu" | "io"): PressureSnapshot | undefined => {
    try {
        return parsePressure(readFileSync(`/proc/pressure/${kind}`, "utf8"));
    } catch {
        return undefined;
    }
};

// The remote-port column of /proc/net/udp{,6} is hex, so a DNS query reads as `:0035`. Such a row is a lookup
// still waiting on an answer; the row's inode column ties it back to whichever process owns the socket.
const DNS_REMOTE_PORT = ":0035";
const INODE_COLUMN = 9;

export const parseDnsSocketInodes = (text: string): string[] =>
    text
        .split("\n")
        .map((line) => line.trim().split(/\s+/))
        .filter((columns) => columns[2]?.endsWith(DNS_REMOTE_PORT))
        .map((columns) => columns[INODE_COLUMN])
        .filter((inode) => inode !== undefined);

// An fd can close between the directory listing and the readlink — a live process racing itself is expected
// here, not exceptional, so a vanished fd is simply not a socket we can attribute.
const socketInode = (fd: string): string | undefined => {
    try {
        return readlinkSync(`/proc/self/fd/${fd}`).match(/^socket:\[(\d+)]$/)?.[1];
    } catch {
        return undefined;
    }
};

// How many DNS lookups THIS process has in flight. The netns-wide table would fold in every agent's and
// child's lookups, and attribution is the entire point of the line — so the DNS rows' inodes are intersected
// with this process's own fds. Sync reads on purpose, same as the pressure files: procfs is memory-backed and
// this runs once per logged stall, not per tick.
const dnsQueriesInFlight = (): number | undefined => {
    try {
        const inodes = new Set([
            ...parseDnsSocketInodes(readFileSync("/proc/net/udp", "utf8")),
            ...parseDnsSocketInodes(readFileSync("/proc/net/udp6", "utf8")),
        ]);
        if (inodes.size === 0) {
            return 0;
        }
        return readdirSync("/proc/self/fd").filter((fd) => {
            const inode = socketInode(fd);
            return inode !== undefined && inodes.has(inode);
        }).length;
    } catch {
        return undefined;
    }
};

export interface LoopWatchdog {
    readonly stop: () => void;
}

export const startLoopWatchdog = (logger: Logger): LoopWatchdog => {
    let last = process.hrtime.bigint();
    let lastCpu = process.cpuUsage();
    let suppressedSince: number | undefined;
    let suppressedCount = 0;
    const timer = setInterval(() => {
        const now = process.hrtime.bigint();
        const lagMs = Number(now - last) / 1e6 - TICK_MS;
        last = now;
        const cpu = process.cpuUsage(lastCpu);
        lastCpu = process.cpuUsage();
        if (lagMs < STALL_THRESHOLD_MS) {
            return;
        }
        if (suppressedSince !== undefined && Date.now() - suppressedSince < LOG_WINDOW_MS) {
            suppressedCount += 1;
            return;
        }
        const memory = process.memoryUsage();
        const resources = process.getActiveResourcesInfo().reduce<Record<string, number>>((counts, resource) => {
            counts[resource] = (counts[resource] ?? 0) + 1;
            return counts;
        }, {});
        logger.warn(
            {
                lagMs: Math.round(lagMs),
                // Taken at recovery — thrash that stalled the loop is usually still measurable the instant after.
                psi: { memory: pressure("memory"), cpu: pressure("cpu"), io: pressure("io") },
                // Nonzero means the loop was parked in getaddrinfo: a forwarded lookup that goes unanswered
                // costs ~8s per attempt, and the stall is a whole multiple of that.
                dnsInFlight: dnsQueriesInFlight(),
                // CPU consumed by this process during the delayed tick. Quiet PSI + high CPU identifies JS/GC;
                // quiet PSI + near-zero CPU points at a blocking native call. Active-resource counts make a
                // leaked watcher/process/timer population visible without attaching an inspector mid-incident.
                processCpuMs: Math.round((cpu.user + cpu.system) / 1000),
                resources,
                heapUsedMb: Math.round(memory.heapUsed / 1048576),
                heapTotalMb: Math.round(memory.heapTotal / 1048576),
                externalMb: Math.round(memory.external / 1048576),
                rssMb: Math.round(memory.rss / 1048576),
                ...(suppressedCount > 0 ? { earlierStallsSuppressed: suppressedCount } : {}),
            },
            "event loop stalled — high PSI means the machine (builds/tests/swap), dnsInFlight means a blocking resolver lookup, quiet both means this process",
        );
        suppressedSince = Date.now();
        suppressedCount = 0;
    }, TICK_MS);
    // The watchdog must never be what keeps the daemon alive.
    timer.unref();
    return { stop: () => clearInterval(timer) };
};
