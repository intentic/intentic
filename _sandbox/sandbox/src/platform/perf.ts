import { loadavg } from "node:os";
import type { Logger } from "pino";

/* WHERE THE DAEMON'S TIME GOES, the attribution layer the stall detector next door cannot provide.
 *
 * loop-watchdog.ts answers "was the loop away, and was it this process's fault"; it cannot answer "away doing
 * WHAT", because by the time a stall is measurable the work that caused it has already returned. Every
 * performance report against this product has died at that gap: the panel felt slow, the log said the loop
 * stalled 4s, and there was no way to tell a slow `git status` from a request queued behind an agent's land
 * from a browser that asked ten times.
 *
 * So the expensive paths measure themselves. Three outputs, deliberately different in cost, audience AND
 * DESTINATION:
 *
 *  - SLOW spans warn immediately, one line each, carrying the fields that identify the instance (which repo,
 *    which argv, how long it waited before it even started) and the machine's load at the time. They go to
 *    logs/perf.jsonl, NOT to daemon.log, see `slowLogger` below for why that split had to happen.
 *  - EVERY span logs at debug, so raising logLevel turns the same instrumentation into a trace without a
 *    rebuild. Off at the default level, and the fields are built lazily so an off debug costs one comparison.
 *  - A rolling SUMMARY prints periodically to daemon.log, ranked by TOTAL time rather than by worst case. That
 *    ranking is the point: a 4s scan that happens twice an hour is not the bottleneck a 40ms read that happens
 *    900 times a minute is, and only the sum tells the two apart. This is what you read after the fact, when
 *    the complaint is "it was slow ten minutes ago", and it stays in the main log because that is where
 *    somebody investigating an incident is already looking.
 *
 * Everything is in-memory and bounded (one row per op name, one retained sample per row). Nothing here is on a
 * request's critical path beyond a hrtime read and a map lookup. */

// A span slower than this warns, unless its op names its own floor below. Deliberately low: at the scale this
// daemon works at (one machine, one user, git against a local disk), a control-plane operation that takes a
// third of a second is already something the user can feel.
const DEFAULT_SLOW_MS = 300;

/* Per-op floors, for the ops whose honest cost is not the default. An op missing from here takes DEFAULT_SLOW_MS.
 *
 * These are the "this is normal, don't cry wolf" numbers, set them from what the op legitimately costs, never
 * from what you wish it cost. A floor set too high is how a real regression stays invisible; a floor set too
 * low is how the log becomes noise nobody reads, which is the same thing one step later. */
const SLOW_MS: Readonly<Record<string, number>> = {
    // One git subprocess. The forker exists to keep this near-instant (see scaffold/exec.ts); a plain read that
    // takes a fifth of a second means the fork is being paid from a large heap, or the disk is contended.
    "git.run": 200,
    // The part of a git call that was NOT git: the spawn queue, the IPC hop, and this process's own event loop
    // being away. Floored low like git.lock.wait and for the same reason, this is not work, it is a queue, so
    // any measurable amount of it is worth a line. When this row rivals git.run's total, the repositories are
    // innocent and the loop is the thing to open.
    "git.run.wait": 150,
    // The whole Changes review: a repo walk plus a status/remote/attribution round per repo. It is the single
    // most expensive read the daemon serves, and the browser can ask for it once a second.
    "git.scan": 1_000,
    // One repo's slice of that scan.
    "git.scan.repo": 500,
    // Waiting for a repo's op chain. This is NOT work, it is the queue behind an agent's land, so any
    // measurable wait is worth a line: it is the difference between "git is slow" and "git was busy".
    "git.lock.wait": 150,
    // Holding it. A land checks out a monorepo, so seconds here are expected; only a stall is not.
    "git.lock.hold": 5_000,
    // The repo discovery walk on its own (up to MAX_DIRS readdirs).
    "git.discover": 400,
    // One HTTP request, end to end, as the browser experiences it.
    "http.request": 1_000,
    /* One round trip to one of the user's own computers, over its WebSocket, to read what it is running. The
     * floor is high because the honest cost is a network hop to somebody's laptop and back (measured at 1-3s on
     * a healthy link), not because slowness here is acceptable: past this the machine is in trouble, and the
     * deadline in machine-reports.ts cuts it off shortly after.
     *
     * It is off the request path (the Computers route serves its last reading and refreshes behind it), so a slow
     * row here is a fact about a MACHINE, and reading it next to `computers.read` is what tells the two apart. */
    "computers.pull": 4_000,
    // Pushing one frame to one connected browser's /events stream.
    "events.frame": 250,
};

// How often the ranked summary prints while anything is being measured. Long enough not to be noise, short
// enough that a user who noticed a stall can still find the window it happened in.
const SUMMARY_MS = 60_000;

// How many ranked rows the summary prints before its wait siblings are added back (see summaryRows). Past the
// top handful the tail is noise, and the whole point of the line is that it fits in one screen during an
// incident.
const SUMMARY_ROWS = 12;

/* THE WAIT HALF OF A WORK OP, so the summary can print the pair rather than whichever of them ranked.
 *
 * A wait op measures a QUEUE, so its total is small by construction and it loses a ranking-by-total-time to the
 * very op it explains. That is not a tie-break detail, it is how this daemon got misread: `git.lock.hold` made
 * the top twelve, `git.lock.wait` fell off the bottom, and a performance review read a summary showing only
 * holds and concluded the repo lock was contended. The waits said 2.3% slow, and nobody could see them. Half of
 * a two-sided measurement is worse than neither half, because it reads as a whole one.
 *
 * Pairing is by name and needs no registry: `X.hold` pairs with `X.wait` (the lock's spelling), anything else
 * with `<itself>.wait` (git.run's). An op whose sibling was never recorded contributes nothing. */
const waitOpFor = (op: string): string => (op.endsWith(".hold") ? `${op.slice(0, -".hold".length)}.wait` : `${op}.wait`);

// The retained-sample and log payloads. Values stay primitive so a pino line is greppable and a summary row
// can be read without a JSON parser in the loop.
export type PerfFields = Readonly<Record<string, string | number | boolean | undefined>>;

// One op's rolling account. `slowest` keeps the identifying fields of the worst instance seen, which is what
// turns "git.run is your bottleneck" into "git.run, `ls-files --others`, in repo intentic".
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
    /** Measure `run`, attributing it to `op`. Returns exactly what `run` returns and rethrows what it throws,
     *  a failed span is still a span, and a slow failure is the most interesting kind. `fields` is evaluated
     *  once, up front, so a caller can name the instance (repo, path, argv) without building it twice. */
    readonly track: <T>(op: string, fields: PerfFields, run: () => Promise<T>) => Promise<T>;
    /** File a span someone else timed, the git runner measures inside the retry loop, where only it can see
     *  how much of the elapsed time was contention. */
    readonly record: (op: string, ms: number, fields: PerfFields, failed?: boolean) => void;
    /** Every op's rolling account, ranked by total time spent. The summary line's content, exposed so a route
     *  or a test can read the same numbers without waiting for the timer. */
    readonly ranked: () => readonly PerfStat[];
    readonly stop: () => void;
}

const elapsedMs = (from: bigint): number => Number(process.hrtime.bigint() - from) / 1e6;

/* THE MACHINE'S ONE-MINUTE LOAD, cached, stamped onto every slow span.
 *
 * This is the field that turns a slow line from a report into a diagnosis. The single most expensive lesson in
 * this repository's CI history is that the same operation is a fifth of a second idle and 5.7 seconds on a busy
 * build machine, and that a check calling the second one a hang cost a red main. Without the load beside the
 * duration, "slow" and "broken" are the same line, and the reader has to go and join a second file on timestamp
 * to tell them apart, which in practice means nobody does.
 *
 * `loadavg()` is a cheap read, but a slow span can fire hundreds of times a second under exactly the conditions
 * this measures, so it is cached for a window well under the metric's own resolution: the kernel's 1-minute
 * average does not move meaningfully inside a second, and a cache miss is one syscall rather than one per span.
 * Rounded to one decimal, which is all the precision a load average has ever deserved. */
const LOAD_CACHE_MS = 1_000;
let loadCache: { at: number; value: number } | undefined;
const load1 = (now: number): number => {
    if (loadCache === undefined || now - loadCache.at >= LOAD_CACHE_MS) {
        loadCache = { at: now, value: Math.round((loadavg()[0] ?? 0) * 10) / 10 };
    }
    return loadCache.value;
};

// Two decimals below 10ms, whole numbers above: a sub-millisecond git read and a four-second scan both have to
// be readable in the same column, and rounding the former to 0 loses the only thing it had to say.
const round = (ms: number): number => (ms < 10 ? Math.round(ms * 100) / 100 : Math.round(ms));

/* `slowLogger` is where the per-span slow lines go, and it is a separate destination on purpose.
 *
 * Pointed at logs/perf.jsonl (logger.ts createPerfLogger). Undefined ⇒ nowhere else to write, a dev run with no
 * /history volume or a pretty single-stream console, and the lines fall back to `logger` as before, because
 * losing them is worse than crowding one dev console.
 *
 * The reason for the split is in createPerfLogger's own comment: these lines outnumbered everything else in
 * daemon.log by roughly three to one and made six real errors unfindable. */
export const createPerfTracker = (logger: Logger, slowLogger: Logger | undefined = undefined): PerfTracker => {
    const slowSink = slowLogger ?? logger;
    const stats = new Map<string, PerfStat>();
    // Anything measured since the last summary. A daemon nobody is using must not print a table of zeroes
    // every minute, an idle sandbox's log is where a real incident has to stay visible.
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
            // The op's own running count rides along so one line answers "is this the first time or the
            // four-hundredth", the question that decides whether to look at this instance or at the pattern.
            // `load1` answers the other one: whether this was the machine or the code (see load1 above).
            slowSink.warn({ perf: op, ms: round(ms), ...fields, seen: stat.count, slowSeen: stat.slowCount, load1: load1(Date.now()) }, `slow ${op}`);
            return;
        }
        // Every span at debug: the same instrumentation becomes a full trace by raising logLevel, with no
        // rebuild and no second code path to keep honest. `isLevelEnabled` keeps an off debug to one check.
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
            // Recorded, then rethrown untouched, the caller's error handling is none of this module's business.
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
                // Ranked by total, capped, plus the wait half of whatever made the cut (see summaryRows).
                // The quiet fields are `undefined` rather than conditionally spread: JSON drops them, so a row
                // with nothing slow and nothing failed prints just as narrow either way.
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
        // Counts are cumulative for the daemon's life on purpose: a rolling reset would hide the op that is
        // slow once an hour, which is exactly the complaint that is hardest to reproduce on demand.
    }, SUMMARY_MS);
    // Measurement must never be what keeps the daemon alive.
    timer.unref();

    return { track, record, ranked, stop: () => clearInterval(timer) };
};
