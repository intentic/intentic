/* WHERE THE BROWSER'S TIME GOES, the daemon's platform/perf.ts, on this side of the wire.
 *
 * The daemon can only ever account for the half of a slow interaction that it served. When the user says the
 * /agents board stutters or a popped-out chat lags, the daemon's log is often completely clean, because
 * nothing was wrong with it: the time went into a query the browser fired six times, a stream frame that
 * rebuilt a thousand-message transcript, or a persist that structured-cloned the whole query cache. None of
 * that was measured anywhere, and "the UI feels slow" has no next step without it.
 *
 * Three outputs, mirroring the daemon's:
 *
 *  - SLOW spans warn to the console as they happen, ALWAYS, not behind the verbose toggle. A stall the user
 *    only notices once has to leave a trace without having been armed for in advance, which is the entire
 *    difference between this being useful and being a thing nobody remembers to turn on.
 *  - Every span at debug, behind `__intenticPerf.verbose(true)` (persisted, so it survives the reload you are
 *    about to do). That is the trace you turn on once you know which interaction to watch.
 *  - A ranked table from `__intenticPerf.table()`, ordered by TOTAL time rather than worst case, because a
 *    bottleneck is what consumed the most time, not what took longest once. A 12ms reducer call is nothing; the
 *    same call 900 times during one streamed answer is ten seconds of dropped frames.
 *
 * The ring buffer records unconditionally (it is an array write), so the spans leading up to a stall are still
 * there afterwards, `__intenticPerf.dump()` in the console after the fact is the intended workflow. */

// A span slower than this warns. The browser's budget is a frame, not a request: past ~50ms of main-thread work
// the user sees a dropped frame, and past ~200ms an interaction feels detached from the click that caused it.
const DEFAULT_SLOW_MS = 200;

/* Per-op floors. Network ops get room (a daemon round-trip over a tunnel is not the browser's fault, and this
 * table is about finding the browser's own problems); anything on the main thread gets a frame budget, because
 * that is what it is spending. */
const SLOW_MS: Readonly<Record<string, number>> = {
    // A daemon round-trip. Generous: the tunnel and the daemon's own work are both inside it, and the daemon's
    // http.request line is what says which side was responsible.
    "rpc.request": 1_500,
    // One vue-query fetch, including its queryFn, so the gap between this and rpc.request is the cache/query
    // machinery's own cost.
    "query.fetch": 1_500,
    // Folding the agent frames that arrived since the last paint into the transcript. Main thread, once per
    // paint rather than once per frame (Conversation buffers them), so its `frames` field says how many it
    // carried. Its budget IS a frame: past this a streaming turn cannot hold 60fps.
    "chat.frame": 16,
    // The typewriter's reveal, on the same tick as the fold above. Runs on every paint of an answer whether
    // frames arrived or not, and pays a whole transcript rebuild to append a few characters to one bubble.
    "chat.type": 8,
    // Mirroring a transcript to IndexedDB.
    "chat.persist": 300,
    // Dehydrating + writing the whole vue-query cache to IndexedDB. A structured clone of megabytes.
    "query.persist": 500,
};

// How many spans the ring buffer keeps. Enough to cover the seconds around a stall (a streaming turn produces
// a few hundred spans a second at worst), small enough to be free.
const RING = 1_000;

export type PerfFields = Readonly<Record<string, string | number | boolean | undefined>>;

export interface PerfSpan {
    readonly op: string;
    readonly ms: number;
    readonly at: number;
    readonly fields: PerfFields;
}

export interface PerfStat {
    readonly op: string;
    count: number;
    totalMs: number;
    maxMs: number;
    slowCount: number;
}

const ring: PerfSpan[] = [];
const stats = new Map<string, PerfStat>();

// Persisted so it survives the reload that usually follows deciding to look. localStorage rather than a ref:
// this is read on paths that must not take a reactivity dependency on it.
const VERBOSE_KEY = `intentic.perf.verbose`;
let verbose = ((): boolean => {
    try {
        return localStorage.getItem(VERBOSE_KEY) === `1`;
    } catch {
        // Private mode / storage disabled, measurement is never allowed to be why something breaks.
        return false;
    }
})();

const round = (ms: number): number => (ms < 10 ? Math.round(ms * 100) / 100 : Math.round(ms));

/** File a span. Called from the timing helpers below and from the two places that measure by hand (the stream
 *  reducer and the typewriter, which are synchronous and re-enter too often to afford a closure each). */
export const recordPerf = (op: string, ms: number, fields: PerfFields = {}): void => {
    const stat = stats.get(op) ?? { op, count: 0, totalMs: 0, maxMs: 0, slowCount: 0 };
    stat.count += 1;
    stat.totalMs += ms;
    stat.maxMs = Math.max(stat.maxMs, ms);
    const slow = ms >= (SLOW_MS[op] ?? DEFAULT_SLOW_MS);
    stat.slowCount += slow ? 1 : 0;
    stats.set(op, stat);
    ring.push({ op, ms, at: Date.now(), fields });
    if (ring.length > RING) {
        ring.shift();
    }
    if (slow) {
        // `seen`/`slowSeen` answer the question the single line otherwise raises, is this the first time, or
        // has it been doing this all along, without needing the table.
        console.warn(`[perf] slow ${op} ${round(ms)}ms`, { ...fields, seen: stat.count, slowSeen: stat.slowCount });
        return;
    }
    if (verbose) {
        console.debug(`[perf] ${op} ${round(ms)}ms`, fields);
    }
};

/** Measure an async operation. Returns what it returns, rethrows what it throws, a failed call is still a
 *  span, and a slow failure is the most interesting kind. */
export const trackPerf = async <T>(op: string, fields: PerfFields, run: () => Promise<T>): Promise<T> => {
    const from = performance.now();
    try {
        return await run();
    } finally {
        recordPerf(op, performance.now() - from, fields);
    }
};

// Ranked by total time, see the module comment for why that and not max.
const ranked = (): readonly PerfStat[] => [...stats.values()].toSorted((left, right) => right.totalMs - left.totalMs);

/* The console handle. Attached to the window rather than exported for a component, because the moment it is
 * wanted is the moment something is already going wrong and the only tool in reach is devtools:
 *
 *   __intenticPerf.table()          ranked, start here, the top row is your bottleneck
 *   __intenticPerf.dump()           the last 1000 spans, newest last, what led up to a stall
 *   __intenticPerf.dump('chat')     …filtered to ops starting with 'chat'
 *   __intenticPerf.verbose(true)    log every span from now on (survives reload)
 *   __intenticPerf.reset()          zero the table before reproducing something deliberately
 */
export const installPerfConsole = (): void => {
    (globalThis as unknown as Record<string, unknown>)[`__intenticPerf`] = {
        table: (): void => {
            console.table(
                ranked().map((stat) => ({
                    op: stat.op,
                    count: stat.count,
                    totalMs: Math.round(stat.totalMs),
                    meanMs: round(stat.totalMs / stat.count),
                    maxMs: Math.round(stat.maxMs),
                    slow: stat.slowCount,
                })),
            );
        },
        dump: (prefix?: string): readonly PerfSpan[] => (prefix === undefined ? [...ring] : ring.filter((span) => span.op.startsWith(prefix))),
        verbose: (on: boolean): void => {
            verbose = on;
            try {
                localStorage.setItem(VERBOSE_KEY, on ? `1` : `0`);
            } catch {
                // Unavailable storage costs the persistence, not the setting.
            }
            console.info(`[perf] verbose ${on ? `on` : `off`}`);
        },
        reset: (): void => {
            stats.clear();
            ring.length = 0;
        },
    };
};
