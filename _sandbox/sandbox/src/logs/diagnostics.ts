import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { logsRoot } from "./log-files.js";

/* READING THE DAEMON'S OWN RECORDS BACK, the half that was missing.
 *
 * Everything under historyRoot/logs is written well and was, in practice, unreadable. Measured over 728 real
 * sessions: the /logs list-and-tail route was used ZERO times, daemon.log was opened 150 times, the resource
 * series 69, and against that agents hand-rolled 1,679 private /tmp/*.log files and added a console.log 178
 * times to find out what was happening. A record nobody reaches for is not a record, and the reason nobody
 * reached for these is that a raw tail of a 5MB JSON log is worse than the print statement it replaces: you get
 * a wall of lines, three quarters of them routine, ordered oldest-first, with no way to say "the errors, from
 * the last ten minutes".
 *
 * So the unit here is a FILTERED READ, not a tail: newest first, bounded by time, by level, by substring. That
 * is the whole difference between this and `tail -n 200 daemon.log`, and it is what the tools next door expose.
 *
 * Everything is read off the file's TAIL rather than the whole file (tailLogFile's budget, passed in), because
 * these files are capped at megabytes and a diagnostic must not read one whole to answer a question about the
 * last ten minutes. A window that starts before the tail begins is reported as such rather than silently
 * answered from less history than was asked for: a reader who cannot tell "nothing happened" from "I could not
 * see that far back" will read the first as the second. */

// How much of a log file's tail is read to answer one query. Generous: the whole daemon.log cap is 5MB, so this
// is most of it, and the parse is a few thousand JSON.parse calls against a bounded string.
export const TAIL_BUDGET_BYTES = 2_000_000;

// pino's numeric levels, and the floor vocabulary a caller filters by. `warn` means warn-and-worse, which is
// what "show me what went wrong" means in every case anybody asks it.
const LEVELS = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 } as const;
export type LevelName = keyof typeof LEVELS;

export interface LogLineQuery {
    readonly file: string;
    // Inclusive floor: "warn" returns warn, error and fatal.
    readonly level?: LevelName | undefined;
    readonly sinceMs?: number | undefined;
    // Case-insensitive substring, matched against the whole serialized line so it hits a message, a code, a
    // conversation id or a repo name without the caller having to know which field carries it.
    readonly contains?: string | undefined;
    readonly limit: number;
}

export interface LogLineResult {
    // Newest first: a diagnostic reads downwards from "what just happened".
    readonly lines: readonly Record<string, unknown>[];
    // How many lines matched before `limit` cut them, so a caller can tell a quiet window from a truncated one.
    readonly matched: number;
    // The file exists and this many bytes of it were read.
    readonly readBytes: number;
    /* Whether the read started mid-file, i.e. the answer may be missing older matches. The distinction a reader
     * cannot make for themselves and will get wrong in the dangerous direction: an empty answer over a
     * truncated window looks exactly like proof that nothing happened. */
    readonly windowTruncated: boolean;
}

// The tail of a file as text, plus whether that was the whole of it. Undefined for a file that is not there,
// which is a normal answer: perf.jsonl does not exist until something has been slow.
const tailText = async (path: string, bytes: number): Promise<{ text: string; whole: boolean } | undefined> => {
    let raw: Buffer;
    try {
        raw = await readFile(path);
    } catch {
        return undefined;
    }
    if (raw.length <= bytes) {
        return { text: raw.toString("utf8"), whole: true };
    }
    // Drop the first line: slicing by bytes lands mid-line, and half a JSON object is a parse failure that
    // would otherwise read as a corrupt log.
    const text = raw.subarray(raw.length - bytes).toString("utf8");
    return { text: text.slice(text.indexOf("\n") + 1), whole: false };
};

// A pino line's own timestamp, in epoch ms. `time` is what pino writes by default; this daemon's loggers are
// configured with isoTime, so `time` is an ISO string. The resource series uses `at` for the same instant.
const lineAt = (line: Record<string, unknown>): number | undefined => {
    const raw = line["time"] ?? line["at"];
    if (typeof raw === "number") {
        return raw;
    }
    const parsed = Date.parse(typeof raw === "string" ? raw : "");
    return Number.isNaN(parsed) ? undefined : parsed;
};

const atLeastLevel = (line: Record<string, unknown>, floor: number): boolean => {
    const level = line["level"];
    // pino writes the label here (this daemon's `formatters.level`), a number under the default config. Unknown
    // labels pass rather than being dropped: a line nobody can classify is exactly the one worth showing.
    if (typeof level === "number") {
        return level >= floor;
    }
    const named = typeof level === "string" ? LEVELS[level as LevelName] : undefined;
    return named === undefined || named >= floor;
};

export const readLogLines = async (historyRoot: string, query: LogLineQuery): Promise<LogLineResult> => {
    const tail = await tailText(join(logsRoot(historyRoot), query.file), TAIL_BUDGET_BYTES);
    if (tail === undefined) {
        return { lines: [], matched: 0, readBytes: 0, windowTruncated: false };
    }
    const floor = query.level === undefined ? 0 : LEVELS[query.level];
    const needle = query.contains?.toLowerCase();
    const hits: Record<string, unknown>[] = [];
    let oldestSeen: number | undefined;
    for (const raw of tail.text.split("\n")) {
        if (raw === "") {
            continue;
        }
        let line: Record<string, unknown>;
        try {
            const parsed: unknown = JSON.parse(raw);
            if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
                continue;
            }
            line = parsed as Record<string, unknown>;
        } catch {
            // A torn line (a truncating prune racing an append) loses one line, never the read.
            continue;
        }
        const at = lineAt(line);
        if (at !== undefined && (oldestSeen === undefined || at < oldestSeen)) {
            oldestSeen = at;
        }
        if (query.sinceMs !== undefined && at !== undefined && at < query.sinceMs) {
            continue;
        }
        if (!atLeastLevel(line, floor)) {
            continue;
        }
        if (needle !== undefined && !raw.toLowerCase().includes(needle)) {
            continue;
        }
        hits.push(line);
    }
    /* The window is only truncated if the file was cut AND the cut is inside the window asked for. A tail that
     * starts after `sinceMs` cannot have hidden anything from this query, so claiming otherwise would attach a
     * warning to a complete answer, and a warning that fires on complete answers is one nobody reads. */
    const windowTruncated = !tail.whole && (query.sinceMs === undefined || oldestSeen === undefined || oldestSeen > query.sinceMs);
    return {
        lines: hits.slice(-query.limit).toReversed(),
        matched: hits.length,
        readBytes: Buffer.byteLength(tail.text, "utf8"),
        windowTruncated,
    };
};

/* ONE FIELD OF THE RESOURCE SERIES OVER TIME, which is the shape that file has never been readable in.
 *
 * resource-metrics.jsonl is the richest thing the daemon records and the least used: one ~4KB object per
 * minute, nested six deep, carrying event-loop percentiles, GC, page faults, V8 space-by-space heap, cgroup OOM
 * counters, PSI pressure and per-role process rollups. Asking it "was the machine busy at 15:22" meant reading
 * a 4KB blob per minute by eye. A dotted path and a window turns that into a series.
 *
 * Dotted rather than a fixed field list, because the interesting field is never the one anybody predicted:
 * `system.cgroup.event_oom_kill` answers why agents were killed, `processes.byRole.browser.rssBytes` answers
 * who ate the memory, `window.eventLoop.delayP99Ms` answers why the UI stuttered, and enumerating those in
 * advance is how the next question goes unanswered. */
export interface MetricPoint {
    readonly at: string;
    readonly value: number;
}

export interface MetricSeries {
    readonly field: string;
    readonly points: readonly MetricPoint[];
    // Over the returned points. Absent when nothing matched, rather than zero, which would read as a measurement.
    readonly min?: number;
    readonly max?: number;
    readonly mean?: number;
    // Samples read that had no such field, which is how a caller learns a path is misspelled rather than quiet.
    readonly missing: number;
}

// Walk a dotted path through nested plain objects. Arrays are not indexed on purpose: nothing in this series is
// an array whose element anybody wants by position (`loadAverage` is the one, and its three values are read
// whole), and supporting it would invite paths that silently mean something else after a shape change.
const at = (source: unknown, path: readonly string[]): unknown =>
    path.reduce<unknown>((value, key) => (value !== null && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined), source);

export const readMetricSeries = async (
    historyRoot: string,
    query: { readonly field: string; readonly sinceMs?: number | undefined; readonly limit: number },
): Promise<MetricSeries> => {
    const tail = await tailText(join(logsRoot(historyRoot), "resource-metrics.jsonl"), TAIL_BUDGET_BYTES);
    if (tail === undefined) {
        return { field: query.field, points: [], missing: 0 };
    }
    const path = query.field.split(".").filter((part) => part !== "");
    const points: MetricPoint[] = [];
    let missing = 0;
    for (const raw of tail.text.split("\n")) {
        if (raw === "") {
            continue;
        }
        let sample: unknown;
        try {
            sample = JSON.parse(raw);
        } catch {
            continue;
        }
        const stamp = at(sample, ["at"]);
        if (typeof stamp !== "string") {
            continue;
        }
        if (query.sinceMs !== undefined && Date.parse(stamp) < query.sinceMs) {
            continue;
        }
        const value = at(sample, path);
        if (typeof value !== "number" || !Number.isFinite(value)) {
            missing += 1;
            continue;
        }
        points.push({ at: stamp, value });
    }
    // Oldest first: a series is read and plotted left-to-right in time, unlike a log, which is read backwards
    // from the present.
    const kept = points.slice(-query.limit);
    if (kept.length === 0) {
        return { field: query.field, points: [], missing };
    }
    const values = kept.map((point) => point.value);
    return {
        field: query.field,
        points: kept,
        min: Math.min(...values),
        max: Math.max(...values),
        mean: Math.round((values.reduce((total, value) => total + value, 0) / values.length) * 1000) / 1000,
        missing,
    };
};
