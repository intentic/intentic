import type { Logger } from "pino";
import { z } from "zod";
import { opt } from "../../../opt.js";
import { BUCKETS, bucketOf, HISTOGRAM_VERSION, histogramQuantile, roundMs, storedHistogram } from "./perf-histogram.js";
import type { PerfFields } from "../perf.js";

// The distribution of EVERY span, not only the slow ones perf.jsonl keeps: per wall-clock window, per op and per subject
// (a request's route, a git subcommand, a hook's tool), one row with the count, the total, the failures, p50/p90/p99/max
// and the histogram they were read from, appended to logs/perf-rollups.jsonl. The histograms add across windows and
// boots, so a reader answers for any span of time with true percentiles (logs/diagnostics-rollups.ts). A window holds
// only what this daemon counted in it, so a restart loses at most the window it was killed in, and a clean stop writes
// even that. Per span the cost is a map lookup and a few counter increments; a cell's buckets are allocated when its
// subject first appears and reused from window to window.

export const PERF_ROLLUPS_FILE = "perf-rollups.jsonl";

// Ten minutes, on the clock: windows from every boot line up, so two daemons' rows for one window simply add.
export const ROLLUP_WINDOW_MS = 10 * 60_000;

// Subjects one op writes rows for in a window, most total time first; the rest fold into OTHER_SUBJECT. With the op-only
// rows this keeps a window to about 120 rows at 2026-11 load (7 git spans and 3.5 requests a second), about 4 MB a day.
const SUBJECT_ROWS = 24;
// Subjects counted apart within a window before any new one goes straight to OTHER_SUBJECT: a route the id folding
// misses must not grow the daemon's memory with every id it carries.
const SUBJECTS_TRACKED = 64;
export const OTHER_SUBJECT = "(other)";

export const alignToWindow = (ms: number): number => Math.floor(ms / ROLLUP_WINDOW_MS) * ROLLUP_WINDOW_MS;

// A path segment that names an instance rather than a route: anything carrying a digit (ids, hashes, ports) and the
// `adjective-noun-xxxx` conversation ids, which carry none often enough (`keen-pine-tkjf`).
const INSTANCE_SEGMENT = /\/(?:[^/]*\d[^/]*|[a-z]+-[a-z]+-[a-z0-9]{4})(?=\/|$)/g;

type FieldValue = PerfFields[string];

const isText = (value: FieldValue): value is string => typeof value === "string";

/** A request's route as `METHOD /path/:id`, query dropped and instance segments folded, so one route is one subject. */
export const routeTemplate = (method: FieldValue, path: string): string =>
    `${isText(method) ? `${method} ` : ""}${(path.split("?")[0] ?? "").replaceAll(INSTANCE_SEGMENT, "/:id")}`;

/** The subcommand of a git label (gitCommandLabel): its first word that is not a global option (`--no-optional-locks`). */
export const gitSubcommand = (label: string): string => label.split(" ").find((word) => word !== "" && !word.startsWith("-")) ?? label;

// Ten git spans a second share a few dozen labels, so each label's subcommand is worked out once.
const subcommands = new Map<string, string>();
const SUBCOMMAND_CACHE = 512;
const cachedSubcommand = (label: string): string => {
    const known = subcommands.get(label);
    if (known !== undefined) {
        return known;
    }
    if (subcommands.size >= SUBCOMMAND_CACHE) {
        subcommands.clear();
    }
    const found = gitSubcommand(label);
    subcommands.set(label, found);
    return found;
};

/** What a span was about, for its rollup row: the route, the git subcommand, else the hook's tool, model role, rule or frame. */
export const spanSubject = (fields: PerfFields): string | undefined => {
    const path = fields["path"];
    if (isText(path)) {
        return routeTemplate(fields["method"], path);
    }
    const git = fields["git"];
    if (isText(git)) {
        return cachedSubcommand(git);
    }
    const named = fields["tool"] ?? fields["role"] ?? fields["rule"] ?? fields["frame"];
    return isText(named) ? named : undefined;
};

// One op and subject's account within the current window.
interface Cell {
    count: number;
    totalMs: number;
    failed: number;
    minMs: number;
    maxMs: number;
    readonly buckets: Uint32Array;
}

const emptyCell = (): Cell => ({ count: 0, totalMs: 0, failed: 0, minMs: Infinity, maxMs: 0, buckets: new Uint32Array(BUCKETS) });

const addInto = (into: Cell, from: Cell): void => {
    into.count += from.count;
    into.totalMs += from.totalMs;
    into.failed += from.failed;
    into.minMs = Math.min(into.minMs, from.minMs);
    into.maxMs = Math.max(into.maxMs, from.maxMs);
    from.buckets.forEach((count, index) => {
        into.buckets[index] = (into.buckets[index] ?? 0) + count;
    });
};

/** One rollup row as written: `at` is the window's start; `from`/`to` appear only on a window counted in part. */
export const rollupRowSchema = z.object({
    at: z.string(),
    op: z.string(),
    subject: z.string().optional(),
    count: z.number().int().nonnegative(),
    totalMs: z.number().nonnegative(),
    failed: z.number().int().nonnegative().optional(),
    p50: z.number(),
    p90: z.number(),
    p99: z.number(),
    minMs: z.number().nonnegative(),
    maxMs: z.number().nonnegative(),
    // When counting began, if after the window's start: the boot that wrote this row started inside it.
    from: z.string().optional(),
    // When the row was written, if not in the window right after it: a clean stop's partial window, or a late timer.
    to: z.string().optional(),
    v: z.number().int(),
    b0: z.number().int().nonnegative(),
    b: z.array(z.number().int().nonnegative()).readonly(),
});
export type RollupRow = z.infer<typeof rollupRowSchema>;

const iso = (ms: number): string => new Date(ms).toISOString();

const rowOf = (at: number, op: string, subject: string, cell: Cell, marks: Pick<RollupRow, "from" | "to">): RollupRow => ({
    at: iso(at),
    op,
    ...opt("subject", subject === "" ? undefined : subject),
    count: cell.count,
    totalMs: Math.round(cell.totalMs),
    ...opt("failed", cell.failed > 0 ? cell.failed : undefined),
    p50: roundMs(histogramQuantile(cell.buckets, cell.count, 0.5, cell.minMs, cell.maxMs)),
    p90: roundMs(histogramQuantile(cell.buckets, cell.count, 0.9, cell.minMs, cell.maxMs)),
    p99: roundMs(histogramQuantile(cell.buckets, cell.count, 0.99, cell.minMs, cell.maxMs)),
    minMs: roundMs(cell.minMs),
    maxMs: roundMs(cell.maxMs),
    ...marks,
    v: HISTOGRAM_VERSION,
    ...storedHistogram(cell.buckets),
});

// One op's rows for a window: the op-only cell, its SUBJECT_ROWS costliest subjects, and the rest folded into one.
const opRows = (op: string, cells: ReadonlyMap<string, Cell>, row: (subject: string, cell: Cell) => RollupRow): RollupRow[] => {
    const named = [...cells].filter(([subject, cell]) => cell.count > 0 && subject !== "" && subject !== OTHER_SUBJECT);
    const ranked = named.toSorted(([, left], [, right]) => right.totalMs - left.totalMs);
    const other = emptyCell();
    for (const [, cell] of ranked.slice(SUBJECT_ROWS)) {
        addInto(other, cell);
    }
    const tracked = cells.get(OTHER_SUBJECT);
    if (tracked !== undefined) {
        addInto(other, tracked);
    }
    const bare = cells.get("");
    return [
        ...(bare !== undefined && bare.count > 0 ? [row("", bare)] : []),
        ...ranked.slice(0, SUBJECT_ROWS).map(([subject, cell]) => row(subject, cell)),
        ...(other.count > 0 ? [row(OTHER_SUBJECT, other)] : []),
    ];
};

export type FlushReason = "boundary" | "stop";

export interface RollupWindows {
    readonly add: (op: string, ms: number, fields: PerfFields, failed: boolean) => void;
    /** When the window being counted ends, epoch ms. */
    readonly endsAt: () => number;
    /** The window so far as JSONL ("" when nothing was counted), and counting starts over in the window `now` is in. */
    readonly flush: (reason: FlushReason) => string;
}

/** The counting and the rows, with no timer and no file: what startRollups drives, and what a test drives by hand. */
export const createRollupWindows = (now: () => number): RollupWindows => {
    const ops = new Map<string, Map<string, Cell>>();
    // When counting into the current window began: the boot, if it came mid-window, else the window's own start.
    let countingFrom = now();
    let windowStart = alignToWindow(countingFrom);

    const add = (op: string, ms: number, fields: PerfFields, failed: boolean): void => {
        let cells = ops.get(op);
        if (cells === undefined) {
            cells = new Map();
            ops.set(op, cells);
        }
        const subject = spanSubject(fields) ?? "";
        let cell = cells.get(subject);
        if (cell === undefined) {
            const key = cells.size < SUBJECTS_TRACKED ? subject : OTHER_SUBJECT;
            cell = cells.get(key) ?? emptyCell();
            cells.set(key, cell);
        }
        cell.count += 1;
        cell.totalMs += ms;
        cell.failed += failed ? 1 : 0;
        cell.minMs = Math.min(cell.minMs, ms);
        cell.maxMs = Math.max(cell.maxMs, ms);
        const bucket = bucketOf(ms);
        cell.buckets[bucket] = (cell.buckets[bucket] ?? 0) + 1;
    };

    // A cell idle for a whole window is dropped; the rest are zeroed in place, keeping their buckets for the next one.
    const reset = (): void => {
        for (const [op, cells] of ops) {
            for (const [subject, cell] of cells) {
                if (cell.count === 0) {
                    cells.delete(subject);
                    continue;
                }
                cell.count = 0;
                cell.totalMs = 0;
                cell.failed = 0;
                cell.minMs = Infinity;
                cell.maxMs = 0;
                cell.buckets.fill(0);
            }
            if (cells.size === 0) {
                ops.delete(op);
            }
        }
    };

    const flush = (reason: FlushReason): string => {
        const at = now();
        const nextStart = alignToWindow(at);
        const onTime = reason === "boundary" && nextStart === windowStart + ROLLUP_WINDOW_MS;
        const marks = { ...opt("from", countingFrom > windowStart ? iso(countingFrom) : undefined), ...opt("to", onTime ? undefined : iso(at)) };
        const row = (op: string) => (subject: string, cell: Cell) => rowOf(windowStart, op, subject, cell, marks);
        const rows = [...ops].flatMap(([op, cells]) => opRows(op, cells, row(op)));
        reset();
        // The next window counts in full only when this one closed at its boundary; otherwise from now.
        countingFrom = onTime ? nextStart : at;
        windowStart = nextStart;
        return rows.length === 0 ? "" : `${rows.map((written) => JSON.stringify(written)).join("\n")}\n`;
    };

    return { add, endsAt: () => windowStart + ROLLUP_WINDOW_MS, flush };
};

/** Appends one window's rows; logger.ts gives the daemon's (logs/perf-rollups.jsonl). */
export type RollupSink = (text: string) => Promise<void>;

export interface Rollups {
    readonly add: RollupWindows["add"];
    /** Stops the clock and writes the window counted so far, resolving once it is written. */
    readonly stop: () => Promise<void>;
}

/**
 * Counts every span into windows and writes each at its boundary, off the event loop; nothing keeps the daemon alive. A
 * failed append is said on `logger` and loses that window alone.
 */
export const startRollups = (sink: RollupSink, logger: Pick<Logger, "warn">, now: () => number = Date.now): Rollups => {
    const windows = createRollupWindows(now);
    // Appends go one after another, so a stop's partial window never lands before the full one ahead of it.
    let writes: Promise<void> = Promise.resolve();
    const write = (text: string): Promise<void> => {
        if (text !== "") {
            writes = writes
                .then(() => sink(text))
                .catch((error) => logger.warn({ err: error, file: PERF_ROLLUPS_FILE }, "perf: a rollup window could not be written"));
        }
        return writes;
    };
    let timer: NodeJS.Timeout | undefined;
    const schedule = (): void => {
        timer = setTimeout(() => {
            // A wall clock stepped back can wake this early; then it only waits out the rest.
            if (now() >= windows.endsAt()) {
                void write(windows.flush("boundary"));
            }
            schedule();
        }, Math.max(0, windows.endsAt() - now()));
        timer.unref();
    };
    schedule();
    return {
        add: windows.add,
        stop: () => {
            clearTimeout(timer);
            return write(windows.flush("stop"));
        },
    };
};
