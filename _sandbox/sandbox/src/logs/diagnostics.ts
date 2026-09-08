import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { logsRoot } from "./log-files.js";

// Reads the daemon's own historyRoot/logs files back: filtered by level, time, and substring, newest-first, unlike a
// raw tail. Reads off the file's tail within a byte budget; a window starting before the tail is reported as truncated
// rather than silently answered short.

// Tail bytes read per query, most of the daemon.log's 5MB cap.
export const TAIL_BUDGET_BYTES = 2_000_000;

// pino's numeric levels; a filter floor of `warn` includes warn and worse.
const LEVELS = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 } as const;
export type LevelName = keyof typeof LEVELS;

export interface LogLineQuery {
    readonly file: string;
    // Inclusive floor: "warn" returns warn, error and fatal.
    readonly level?: LevelName | undefined;
    readonly sinceMs?: number | undefined;
    // Case-insensitive substring matched against the whole serialized line, not one field.
    readonly contains?: string | undefined;
    readonly limit: number;
}

export interface LogLineResult {
    // Newest first: a diagnostic reads downwards from "what just happened".
    readonly lines: readonly Record<string, unknown>[];
    // Matches before `limit` cut them; distinguishes a quiet window from a truncated one.
    readonly matched: number;
    // The file exists and this many bytes of it were read.
    readonly readBytes: number;
    // True when the read started mid-file: older matches may be missing even though the answer is empty.
    readonly windowTruncated: boolean;
}

// Tail of a file as text, and whether that was the whole file. Undefined when the file does not exist (a normal answer,
// e.g. perf.jsonl before anything was slow).
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
    // Drops the first line: a byte slice can land mid-line, leaving a half JSON object that would look corrupt.
    const text = raw.subarray(raw.length - bytes).toString("utf8");
    return { text: text.slice(text.indexOf("\n") + 1), whole: false };
};

// Timestamp in epoch ms; `time` may be pino's default number or this daemon's ISO string. Resource samples use `at`
// instead.
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
    // String label (this daemon) or pino's default number; unrecognized labels pass rather than drop.
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
    // Truncated only if the file was cut and the cut falls inside the requested window, not on every cut file.
    const windowTruncated = !tail.whole && (query.sinceMs === undefined || oldestSeen === undefined || oldestSeen > query.sinceMs);
    return {
        lines: hits.slice(-query.limit).toReversed(),
        matched: hits.length,
        readBytes: Buffer.byteLength(tail.text, "utf8"),
        windowTruncated,
    };
};

// One field of the resource series, picked by dotted path so any nested field (event loop delay, OOM kills, per-role
// memory) is reachable without enumerating them upfront.
export interface MetricPoint {
    readonly at: string;
    readonly value: number;
}

export interface MetricSeries {
    readonly field: string;
    readonly points: readonly MetricPoint[];
    // Over the returned points; absent (not zero) when nothing matched.
    readonly min?: number;
    readonly max?: number;
    readonly mean?: number;
    // Samples read that lacked this field entirely, e.g. from a misspelled path.
    readonly missing: number;
}

// Walks a dotted path through nested plain objects; arrays are never indexed. `loadAverage`, the one array field, is
// read whole rather than by index.
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
    // Oldest first: a series plots left-to-right in time, unlike a newest-first log read.
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
