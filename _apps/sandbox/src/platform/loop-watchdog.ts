import { readFileSync } from "node:fs";
import type { Logger } from "pino";

/* The daemon's own stall detector. Every user-visible outage so far has been the event loop going quiet — the
 * /events heartbeat stops, the browser's watchdog trips, and the UI declares the sandbox gone — with nothing
 * in the log to say WHY. The loop can go quiet for two very different reasons, and the fix for each is the
 * opposite of the other:
 *
 *  - in-process: a synchronous path (a runaway regex, a giant JSON.parse, a GC death spiral) is holding the
 *    loop. The daemon's own /proc pressure numbers stay quiet while it happens.
 *  - environmental: the whole container is descheduled — the VM is swap-thrashing or IO-saturated under a
 *    fleet of builds/tests/checkouts. PSI (/proc/pressure/*) screams, and no daemon code is at fault.
 *
 * A 500ms timer measures its own lateness; a fire that arrives seconds overdue IS the stall, already over.
 * Each stall is logged once with the pressure snapshot taken at recovery, so the log line itself says which
 * of the two worlds the stall came from. Rate-limited: thrash arrives as bursts of stalls, and one line per
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

export interface LoopWatchdog {
    readonly stop: () => void;
}

export const startLoopWatchdog = (logger: Logger): LoopWatchdog => {
    let last = process.hrtime.bigint();
    let suppressedSince: number | undefined;
    let suppressedCount = 0;
    const timer = setInterval(() => {
        const now = process.hrtime.bigint();
        const lagMs = Number(now - last) / 1e6 - TICK_MS;
        last = now;
        if (lagMs < STALL_THRESHOLD_MS) {
            return;
        }
        if (suppressedSince !== undefined && Date.now() - suppressedSince < LOG_WINDOW_MS) {
            suppressedCount += 1;
            return;
        }
        const memory = process.memoryUsage();
        logger.warn(
            {
                lagMs: Math.round(lagMs),
                // Taken at recovery — thrash that stalled the loop is usually still measurable the instant after.
                psi: { memory: pressure("memory"), cpu: pressure("cpu"), io: pressure("io") },
                heapUsedMb: Math.round(memory.heapUsed / 1048576),
                rssMb: Math.round(memory.rss / 1048576),
                ...(suppressedCount > 0 ? { earlierStallsSuppressed: suppressedCount } : {}),
            },
            "event loop stalled — high PSI means the machine (builds/tests/swap), quiet PSI means this process",
        );
        suppressedSince = Date.now();
        suppressedCount = 0;
    }, TICK_MS);
    // The watchdog must never be what keeps the daemon alive.
    timer.unref();
    return { stop: () => clearInterval(timer) };
};
