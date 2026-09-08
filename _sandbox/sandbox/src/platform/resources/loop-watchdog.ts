import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import type { Logger } from "pino";

// Detects why the event loop stalled: in-process (CPU burns, PSI quiet), environmental (PSI screams, no daemon fault),
// or a blocking DNS resolver (PSI and CPU both quiet, dnsInFlight nonzero); each needs a different fix. Logs one
// snapshot per stall at recovery, rate-limited per window since thrash arrives in bursts.

const TICK_MS = 500;
// A loop this daemon runs (timers, SSE heartbeats, SDK stream parsing) is never legitimately away this long.
const STALL_THRESHOLD_MS = 1_500;
// One warn per window; a burst's later stalls only bump the counter the next logged one reports.
const LOG_WINDOW_MS = 10_000;

// One /proc/pressure/<kind> file reduced to two numbers: avg10 of `some` (anything stalling) and `full` (everything
// stalling).
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
    // `full` is absent for CPU (a runnable task always makes progress on something); reported as 0.
    return { some, full: avg10(lines.find((line) => line.startsWith("full"))) ?? 0 };
};

// PSI is a Linux cgroup2 feature; absent (macOS dev, old kernels) just means the stall log carries no attribution. Sync
// reads on purpose: procfs pressure files are memory-backed and this runs once per logged stall.
const pressure = (kind: "memory" | "cpu" | "io"): PressureSnapshot | undefined => {
    try {
        return parsePressure(readFileSync(`/proc/pressure/${kind}`, "utf8"));
    } catch {
        return undefined;
    }
};

// The remote-port column of /proc/net/udp{,6} is hex, so a DNS query reads as `:0035`; the inode column ties such a row
// back to its owning process.
const DNS_REMOTE_PORT = ":0035";
const INODE_COLUMN = 9;

export const parseDnsSocketInodes = (text: string): string[] =>
    text
        .split("\n")
        .map((line) => line.trim().split(/\s+/))
        .filter((columns) => columns[2]?.endsWith(DNS_REMOTE_PORT))
        .map((columns) => columns[INODE_COLUMN])
        .filter((inode) => inode !== undefined);

// An fd can close between the directory listing and the readlink; a vanished fd is simply unattributable, not
// exceptional.
const socketInode = (fd: string): string | undefined => {
    try {
        return readlinkSync(`/proc/self/fd/${fd}`).match(/^socket:\[(\d+)]$/)?.[1];
    } catch {
        return undefined;
    }
};

// DNS lookups this process has in flight: the netns-wide table folds in every process's lookups, so DNS rows' inodes
// are intersected with this process's own fds. Sync reads, same reason as the pressure files.
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
                // Taken at recovery: thrash that stalled the loop is usually still measurable the instant after.
                psi: { memory: pressure("memory"), cpu: pressure("cpu"), io: pressure("io") },
                // Nonzero means the loop was parked in getaddrinfo, roughly 8s lost per unanswered lookup attempt.
                dnsInFlight: dnsQueriesInFlight(),
                // Quiet PSI plus high CPU is JS/GC; near-zero CPU with quiet PSI is a blocking native call.
                processCpuMs: Math.round((cpu.user + cpu.system) / 1000),
                resources,
                heapUsedMb: Math.round(memory.heapUsed / 1048576),
                heapTotalMb: Math.round(memory.heapTotal / 1048576),
                externalMb: Math.round(memory.external / 1048576),
                rssMb: Math.round(memory.rss / 1048576),
                ...(suppressedCount > 0 ? { earlierStallsSuppressed: suppressedCount } : {}),
            },
            "event loop stalled: high PSI means the machine (builds/tests/swap), dnsInFlight means a blocking resolver lookup, quiet both means this process",
        );
        suppressedSince = Date.now();
        suppressedCount = 0;
    }, TICK_MS);
    // The watchdog must never be what keeps the daemon alive.
    timer.unref();
    return { stop: () => clearInterval(timer) };
};
