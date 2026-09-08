import { loadavg } from "node:os";
import type { Logger } from "pino";

// Per-op timing the stall detector can't give: not just that the loop stalled, but what it was doing.
// - slow spans warn once each to logs/perf.jsonl, tagged with load; never to daemon.log
// - every span also logs at debug, so raising logLevel turns this into a full trace
// - a periodic summary ranks ops by total time, not worst case, and prints to daemon.log
// In-memory and bounded: one row and one retained sample per op.

// Default slow threshold for ops with no entry in SLOW_MS; low, since this daemon runs local git for one user.
const DEFAULT_SLOW_MS = 300;

// Per-op slow floors; an op missing here uses DEFAULT_SLOW_MS. Set from real cost, not wished-for cost.
const SLOW_MS: Readonly<Record<string, number>> = {
    // One git subprocess; near-instant via the forker, so slowness here means a large heap or contended disk.
    "git.run": 200,
    // Non-git overhead of a call: spawn queue, IPC, event-loop lag, not the repo itself.
    "git.run.wait": 150,
    // The full Changes review: a repo walk plus status/remote/attribution per repo; the daemon's priciest read.
    "git.scan": 1_000,
    // One repo's slice of git.scan.
    "git.scan.repo": 500,
    // Waiting for a repo's op chain; a queue, not work, so any measurable wait is worth a line.
    "git.lock.wait": 150,
    // Holding the lock; a land checks out a monorepo, so seconds are expected, only a stall is not.
    "git.lock.hold": 5_000,
    // The repo discovery walk alone (up to MAX_DIRS readdirs).
    "git.discover": 400,
    // One HTTP request end to end, as the browser experiences it.
    "http.request": 1_000,
    // A conversation's rebase onto main; replaying a real branch costs seconds, so only a stall is worth a line.
    "agent.sync": 2_000,
    // One land end to end (rebase, preflight, patch); a monorepo's takes seconds. Past this, the classify step is where
    // to look.
    "agent.land": 5_000,
    // One WebSocket round trip to a device; floor is high because the honest cost is a network hop, not tolerance.
    "devices.pull": 4_000,
    // Pushing one frame to one connected browser's /events stream.
    "events.frame": 250,
};

// Interval for the ranked summary to print while anything is being measured.
const SUMMARY_MS = 60_000;

// Ranked rows shown before wait siblings are added back (see summaryRows); keeps it to one screen.
const SUMMARY_ROWS = 12;

// Names the wait op paired with a work op (`X.hold`→`X.wait`, otherwise `<op>.wait`), so the summary can show a wait
// even though its small total loses ranking to the op it explains.
const waitOpFor = (op: string): string => (op.endsWith(".hold") ? `${op.slice(0, -".hold".length)}.wait` : `${op}.wait`);

// Retained-sample and log payload; primitive values keep lines greppable without a JSON parser.
export type PerfFields = Readonly<Record<string, string | number | boolean | undefined>>;

// One op's rolling account; `slowest` keeps the identifying fields of the worst instance seen.
export interface PerfStat {
    readonly op: string;
    count: number;
    totalMs: number;
    maxMs: number;
    slowCount: number;
    failed: number;
    slowest: PerfFields | undefined;
}

export interface PerfTracker {
    /**
     * Measures `run` under `op`, returning what it returns and rethrowing what it throws: a failed span is still a
     * span. `fields` is evaluated once, up front.
     */
    readonly track: <T>(op: string, fields: PerfFields, run: () => Promise<T>) => Promise<T>;
    /**
     * Files a span timed elsewhere, e.g. the git runner's retry loop, which alone can see how much elapsed time was
     * contention.
     */
    readonly record: (op: string, ms: number, fields: PerfFields, failed?: boolean) => void;
    /** Every op's account, ranked by total time; the summary's own content, readable without waiting for the timer. */
    readonly ranked: () => readonly PerfStat[];
    readonly stop: () => void;
}

const elapsedMs = (from: bigint): number => Number(process.hrtime.bigint() - from) / 1e6;

// Load average, cached ~1s, stamped onto slow spans to separate a slow op from a busy machine.
const LOAD_CACHE_MS = 1_000;
let loadCache: { at: number; value: number } | undefined;
const load1 = (now: number): number => {
    if (loadCache === undefined || now - loadCache.at >= LOAD_CACHE_MS) {
        loadCache = { at: now, value: Math.round((loadavg()[0] ?? 0) * 10) / 10 };
    }
    return loadCache.value;
};

// Two decimals below 10ms, whole numbers above: both a sub-ms read and a multi-second scan stay readable.
const round = (ms: number): number => (ms < 10 ? Math.round(ms * 100) / 100 : Math.round(ms));

// Separate destination for slow-span lines (createPerfLogger, logs/perf.jsonl); undefined falls back to `logger` rather
// than dropping them.
export const createPerfTracker = (logger: Logger, slowLogger: Logger | undefined = undefined): PerfTracker => {
    const slowSink = slowLogger ?? logger;
    const stats = new Map<string, PerfStat>();
    // Anything measured since the last summary; an idle daemon must not print a table of zeroes every minute.
    let dirty = false;

    const ranked = (): readonly PerfStat[] => [...stats.values()].toSorted((left, right) => right.totalMs - left.totalMs);

    const summaryRows = (): readonly PerfStat[] => {
        const top = ranked().slice(0, SUMMARY_ROWS);
        const shown = new Set(top.map((stat) => stat.op));
        const waits = top.flatMap((stat) => {
            const sibling = stats.get(waitOpFor(stat.op));
            return sibling !== undefined && !shown.has(sibling.op) ? [sibling] : [];
        });
        return [...top, ...waits];
    };

    const record = (op: string, ms: number, fields: PerfFields, failed = false): void => {
        const slow = ms >= (SLOW_MS[op] ?? DEFAULT_SLOW_MS);
        const stat = stats.get(op) ?? { op, count: 0, totalMs: 0, maxMs: 0, slowCount: 0, failed: 0, slowest: undefined };
        stat.count += 1;
        stat.totalMs += ms;
        stat.failed += failed ? 1 : 0;
        stat.slowCount += slow ? 1 : 0;
        if (ms > stat.maxMs) {
            stat.maxMs = ms;
            stat.slowest = fields;
        }
        stats.set(op, stat);
        dirty = true;
        if (slow) {
            // `seen`/`slowSeen` distinguish first occurrence from pattern; `load1` distinguishes machine from code.
            slowSink.warn({ perf: op, ms: round(ms), ...fields, seen: stat.count, slowSeen: stat.slowCount, load1: load1(Date.now()) }, `slow ${op}`);
            return;
        }
        // Raising logLevel turns this into a full trace; `isLevelEnabled` keeps an off debug to one check.
        if (logger.isLevelEnabled("debug")) {
            logger.debug({ perf: op, ms: round(ms), ...fields }, op);
        }
    };

    const track = async <T>(op: string, fields: PerfFields, run: () => Promise<T>): Promise<T> => {
        const from = process.hrtime.bigint();
        try {
            const result = await run();
            record(op, elapsedMs(from), fields);
            return result;
        } catch (error) {
            // Recorded as failed, then rethrown untouched; error handling is the caller's business.
            record(op, elapsedMs(from), fields, true);
            throw error;
        }
    };

    const timer = setInterval(() => {
        if (!dirty) {
            return;
        }
        dirty = false;
        logger.info(
            {
                // Ranked and capped, plus each cut row's wait half (see summaryRows); undefined fields are dropped by
                // JSON.
                perfSummary: summaryRows().map((stat) => ({
                    op: stat.op,
                    count: stat.count,
                    totalMs: Math.round(stat.totalMs),
                    meanMs: round(stat.totalMs / stat.count),
                    maxMs: Math.round(stat.maxMs),
                    slow: stat.slowCount > 0 ? stat.slowCount : undefined,
                    failed: stat.failed > 0 ? stat.failed : undefined,
                    worst: stat.slowest,
                })),
                windowMs: SUMMARY_MS,
            },
            "perf summary: ranked by TOTAL time, which is what a bottleneck actually is",
        );
        // Counts are cumulative for the daemon's life; a rolling reset would hide an op that is only slow once an hour.
    }, SUMMARY_MS);
    // Measurement must never be what keeps the daemon alive.
    timer.unref();

    return { track, record, ranked, stop: () => clearInterval(timer) };
};
