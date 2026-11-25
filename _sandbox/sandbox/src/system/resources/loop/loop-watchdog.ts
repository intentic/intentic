import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import type { Logger } from "pino";
import { readPressure } from "../cgroup.js";
import { ioPoolState, startIoPoolProbe } from "./io-pool-probe.js";
import type { PerfTracker, SpanActivity } from "../perf.js";

// Detects why the event loop stalled: in-process (CPU burns, PSI quiet), environmental (PSI screams, no daemon fault),
// or a blocking DNS resolver (PSI and CPU both quiet, dnsInFlight nonzero); each needs a different fix. Logs one
// snapshot per stall at recovery, rate-limited per window since thrash arrives in bursts. Once the services exist it also
// names what the daemon was doing (`attribute`): the perf spans running across the stall or ending inside it, longest
// first (perf.ts `during`). A span that ended inside the stall is the likeliest culprit of an in-process one, since the
// blocking work is usually the last thing it did; one still running only says the stall caught it waiting. It runs the
// thread pool's probe beside it (io-pool-probe.ts), whose state each stall line carries.

const TICK_MS = 500;
// A loop this daemon runs (timers, SSE heartbeats, SDK stream parsing) is never legitimately away this long.
const STALL_THRESHOLD_MS = 1_500;
// One warn per window; a burst's later stalls only bump the counter the next logged one reports.
const LOG_WINDOW_MS = 10_000;

/* A SLEEPING HOST IS SAID, NOT LEFT AS A GAP (2026-11-19). A laptop's lid closed at 05:43 and opened at 09:47: the
   sandbox's VM stood still four hours, its monotonic clock with it, so no stall was logged and the resource series just
   stopped. The first thing after the wake was a refused credential, and an agent asked why the night's work took so
   long blamed the sign-in for the whole gap. The wall clock is set right on waking, so a tick whose wall clock ran far
   ahead of its monotonic one is the machine stopped under the daemon: a sleep, or a clock set forward. Said once, as
   the gap it was; a conversation's timeline reads it back (diagnostics-history.ts). */
const PAUSE_MS = 60_000;
export const PAUSED_LINE =
    "sandbox paused: the wall clock jumped ahead while the monotonic clock stood still, so the machine this sandbox runs on slept (a lid closed, a host suspended) or its clock was set forward; nothing here ran in between, and a turn's duration counts the gap";

/** How long the machine stood still under one tick: the wall clock's lead over the monotonic one, past PAUSE_MS. */
export const pausedFor = (wallMs: number, monotonicMs: number): number | undefined => {
    const lead = wallMs - monotonicMs;
    return lead >= PAUSE_MS ? Math.round(lead) : undefined;
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
        // allow(silent-catch): an fd that closed between the listing and this read has no socket to count.
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
        // allow(silent-catch): a /proc this process cannot list leaves the count unknown, which the stall report omits.
        return undefined;
    }
};

export interface LoopWatchdog {
    readonly stop: () => void;
    // Names the perf spans across each stall from now on; the watchdog starts before the services that track them.
    readonly attribute: (perf: Pick<PerfTracker, "during">) => void;
}

// How many spans a stall line names.
const SPANS_NAMED = 5;

// One span as a stall line carries it: op, how long, whether it was still running, and the fields it was tracked with.
const spanSummary = (span: SpanActivity, now: number) => ({
    op: span.op,
    ms: (span.endedAt ?? now) - span.startedAt,
    running: span.endedAt === undefined,
    ...span.fields,
});

export const startLoopWatchdog = (logger: Logger): LoopWatchdog => {
    let last = process.hrtime.bigint();
    let lastWall = Date.now();
    let lastCpu = process.cpuUsage();
    let suppressedSince: number | undefined;
    let suppressedCount = 0;
    let perf: Pick<PerfTracker, "during"> | undefined;
    // Its twin for libuv's thread pool, which a hung network mount fills while the loop still turns.
    const ioPool = startIoPoolProbe(logger);
    const timer = setInterval(() => {
        const now = process.hrtime.bigint();
        const tickMs = Number(now - last) / 1e6;
        const lagMs = tickMs - TICK_MS;
        last = now;
        const wall = Date.now();
        const paused = pausedFor(wall - lastWall, tickMs);
        if (paused !== undefined) {
            logger.warn({ pausedMs: paused, from: new Date(lastWall).toISOString(), to: new Date(wall).toISOString() }, PAUSED_LINE);
        }
        lastWall = wall;
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
        const stall = {
            lagMs: Math.round(lagMs),
            // Nonzero means the loop was parked in getaddrinfo, roughly 8s lost per unanswered lookup attempt.
            dnsInFlight: dnsQueriesInFlight(),
            // Quiet PSI plus high CPU is JS/GC; near-zero CPU with quiet PSI is a blocking native call.
            processCpuMs: Math.round((cpu.user + cpu.system) / 1000),
            resources,
            heapUsedMb: Math.round(memory.heapUsed / 1048576),
            heapTotalMb: Math.round(memory.heapTotal / 1048576),
            externalMb: Math.round(memory.external / 1048576),
            rssMb: Math.round(memory.rss / 1048576),
            // Whether libuv's thread pool answers (io-pool-probe.ts): a pool held by a hung mount stalls every fs call.
            ioPool: ioPoolState(),
            ...(suppressedCount > 0 ? { earlierStallsSuppressed: suppressedCount } : {}),
        };
        const at = Date.now();
        // From when the loop last ticked: what ran across the stall, and what ended inside it.
        const spans = perf?.during(at - Math.round(lagMs) - TICK_MS, SPANS_NAMED).map((span) => spanSummary(span, at));
        // Taken at recovery: thrash that stalled the loop is usually still measurable the instant after.
        void readPressure().then((psi) =>
            logger.warn(
                { ...stall, psi, spans },
                "event loop stalled: high PSI means the sandbox (builds/tests/swap), dnsInFlight means a blocking resolver lookup, quiet both means this process; spans names what the daemon was doing, a span that ended inside the stall being the likeliest culprit",
            ),
        );
        suppressedSince = Date.now();
        suppressedCount = 0;
    }, TICK_MS);
    // The watchdog must never be what keeps the daemon alive.
    timer.unref();
    return {
        stop: () => {
            clearInterval(timer);
            ioPool.stop();
        },
        attribute: (tracker) => {
            perf = tracker;
        },
    };
};
