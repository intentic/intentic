// Measures browser-side time the daemon's own perf.ts can't see (a query fired six times, a stream frame
// rebuilding a huge transcript), since "the UI feels slow" has no next step without it. Three outputs: slow spans
// always warn to the console (armed by default, not opt-in); every span at debug behind
// `__intenticPerf.verbose(true)` (persisted); a table from `__intenticPerf.table()` ranked by total time, since a
// bottleneck is what consumed the most time, not what took longest once. The ring buffer records unconditionally,
// so `__intenticPerf.dump()` after a stall still shows what led into it.

// Default slow-span threshold; past ~200ms an interaction starts to feel detached from the click that caused it.
const DEFAULT_SLOW_MS = 200;

// Per-op thresholds: network ops get room (a round-trip isn't the browser's fault); main-thread ops get a frame
// budget, since that's what they spend.
const SLOW_MS: Readonly<Record<string, number>> = {
    // A daemon round-trip; generous since the tunnel and the daemon's own work are both inside it (its own
    // http.request span says which side was slow).
    "rpc.request": 1_500,
    // One vue-query fetch, including its queryFn, so the gap between this and rpc.request is the cache/query
    // machinery's own cost.
    "query.fetch": 1_500,
    // Folding buffered agent frames into the transcript, once per paint; its budget is a frame, since past this a
    // streaming turn can't hold 60fps.
    "chat.frame": 16,
    // The typewriter's reveal; runs every paint of an answer, paying a full transcript rebuild to append a few
    // characters.
    "chat.type": 8,
    // Mirroring a transcript to IndexedDB.
    "chat.persist": 300,
    // Dehydrating and writing the whole vue-query cache to IndexedDB, a structured clone of megabytes.
    "query.persist": 500,
};

// Ring buffer size: enough to cover the seconds around a stall, small enough to stay free.
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

// Persisted so it survives the reload that usually follows deciding to look. `localStorage`, not a ref, since it's
// read on paths that must not take a reactivity dependency on it.
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

// Drops `undefined` fields (PerfFields allows them, the report schema doesn't) rather than stringifying them,
// which would read as an intended value.
const primitives = (fields: PerfFields): Record<string, string | number | boolean> =>
    Object.fromEntries(Object.entries(fields).filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined));

// Injected, not imported: this module sits near the root of the import graph (sandboxRpc wraps every call in
// `trackPerf`), and importing the reporter directly would cycle back through clientDiagnostics → sandboxAuthFetch
// → sandboxSession → useSandbox into the app's own graph. `main.ts` hands the sink in (installPerfReporter); until
// then, or in a test that never calls it, a slow span costs one comparison.
type SlowReporter = (op: string, ms: number, fields: Record<string, string | number | boolean>, requestId: string | undefined) => void;
let reportSlow: SlowReporter | undefined;
export const installPerfReporter = (reporter: SlowReporter): void => {
    reportSlow = reporter;
};

/**
 * Files a span. Also called by hand from the stream reducer and the typewriter, which re-enter too often to
 * afford a closure each.
 */
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
        // `seen`/`slowSeen` answer whether this is the first occurrence or an ongoing one, without needing the table.
        console.warn(`[perf] slow ${op} ${round(ms)}ms`, { ...fields, seen: stat.count, slowSeen: stat.slowCount });
        // Durable, at `warn`: a slow-UI complaint is unactionable from a console line nobody was watching. Only slow
        // spans
        // leave the browser (every span still lands in the ring buffer and table); reporting all of them would itself
        // flood the diagnostic channel during a streaming turn.
        reportSlow?.(
            op,
            round(ms),
            { op, ms: round(ms), seen: stat.count, slowSeen: stat.slowCount, ...primitives(fields) },
            typeof fields["requestId"] === `string` ? fields["requestId"] : undefined,
        );
        return;
    }
    if (verbose) {
        console.debug(`[perf] ${op} ${round(ms)}ms`, fields);
    }
};

/**
 * Measures an async op; rethrows what it throws, since a failed call is still a span, and a slow failure is the
 * most interesting kind.
 */
export const trackPerf = async <T>(op: string, fields: PerfFields, run: () => Promise<T>): Promise<T> => {
    const from = performance.now();
    try {
        return await run();
    } finally {
        recordPerf(op, performance.now() - from, fields);
    }
};

// Ranked by total time, not worst case: what consumed the most time overall is the bottleneck.
const ranked = (): readonly PerfStat[] => [...stats.values()].toSorted((left, right) => right.totalMs - left.totalMs);

// Console handle, attached to the window rather than exported, since the moment it's needed the only tool in reach
// is devtools:
//
//   __intenticPerf.table() ranked, start here, the top row is your bottleneck
//   __intenticPerf.dump() the last 1000 spans, newest last, what led up to a stall
//   __intenticPerf.dump('chat') …filtered to ops starting with 'chat'
//   __intenticPerf.verbose(true) log every span from now on (survives reload)
//   __intenticPerf.reset() zero the table before reproducing something deliberately
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
