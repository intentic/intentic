import { join } from "node:path";
import { isJsonObject, type JsonObject } from "../store/evolution/conversions.js";
import { quantile, templateOf } from "./diagnostics-shape.js";
import { logsRoot, rotatedSegment } from "./log-files.js";
import { parseRecord, type ScanCoverage, scanNewestFirst } from "./log-read.js";

// Reads the daemon's own historyRoot/logs files back: filtered by level, time, and substring, newest-first, unlike a
// raw tail. Reads backwards from the end of each file (and on into its rotated segment) only as far as the window asks,
// within a byte budget; whatever the read could not reach is reported, never silently answered short.

// Bytes read per log query: more than a rotated log and its older segment hold together (log-files.ts), so a whole
// daemon.log is always reachable.
export const LOG_BUDGET_BYTES = 16_000_000;
// The resource series' own cap is 40 MB; its whole file stays reachable.
const SERIES_BUDGET_BYTES = 48_000_000;
// Distinct message shapes tracked per read; past it, the rest count under one row rather than growing without bound.
const MAX_GROUPS = 2_000;

// pino's numeric levels; a filter floor of `warn` includes warn and worse.
const LEVELS = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 } as const;
export type LevelName = keyof typeof LEVELS;

const isText = (value: unknown): value is string => typeof value === "string";

const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

const LEVEL = /"level":(?:"(\w+)"|(\d+))/;

// String label (this daemon) or pino's default number; an unrecognized label or none at all passes rather than drops.
const atLeastLevel = (raw: string, floor: number): boolean => {
    const found = LEVEL.exec(raw);
    if (found === null) {
        return true;
    }
    const label = found[1];
    // SAFETY: `label in LEVELS` is checked first, so the label names one of its keys.
    const named = label === undefined ? Number(found[2]) : label in LEVELS ? LEVELS[label as LevelName] : undefined;
    return named === undefined || named >= floor;
};

/** A log and its older segment, newest first: what a read of `name` walks. */
export const logPaths = (historyRoot: string, name: string): string[] => {
    const path = join(logsRoot(historyRoot), name);
    return [path, rotatedSegment(path)];
};

export interface LogLineQuery {
    readonly file: string;
    // Inclusive floor: "warn" returns warn, error and fatal.
    readonly level?: LevelName | undefined;
    readonly sinceMs?: number | undefined;
    // Case-insensitive substring matched against the whole serialized line, not one field.
    readonly contains?: string | undefined;
    // Narrows further on the parsed line.
    readonly where?: ((line: JsonObject) => boolean) | undefined;
    readonly limit: number;
    readonly budgetBytes?: number | undefined;
}

// Lines that share a message once ids and numbers are taken out of it.
export interface LineGroup {
    readonly template: string;
    count: number;
    readonly newestAt: number | undefined;
    oldestAt: number | undefined;
    // The newest line of the group, as it was written.
    readonly example: JsonObject;
}

export interface LogLineResult {
    // Newest first: a diagnostic reads downwards from "what just happened".
    readonly lines: readonly JsonObject[];
    // Matches before `limit` cut them; distinguishes a quiet window from a truncated one.
    readonly matched: number;
    // Every match, grouped by message shape, most frequent first.
    readonly groups: readonly LineGroup[];
    readonly coverage: ScanCoverage;
    // The file exists and this many bytes of it were read.
    readonly readBytes: number;
    // True when the budget ran out inside the window: older matches may be missing even though the answer is empty.
    readonly windowTruncated: boolean;
}

const groupLine = (groups: Map<string, LineGroup>, line: JsonObject, at: number | undefined): void => {
    const template = groups.size < MAX_GROUPS ? templateOf(line) : "(other messages)";
    const known = groups.get(template);
    if (known === undefined) {
        groups.set(template, { template, count: 1, newestAt: at, oldestAt: at, example: line });
        return;
    }
    known.count += 1;
    known.oldestAt = at ?? known.oldestAt;
};

export const readLogLines = async (historyRoot: string, query: LogLineQuery): Promise<LogLineResult> => {
    const floor = query.level === undefined ? 0 : LEVELS[query.level];
    const needle = query.contains?.toLowerCase();
    const lines: JsonObject[] = [];
    const groups = new Map<string, LineGroup>();
    let matched = 0;
    const coverage = await scanNewestFirst(
        logPaths(historyRoot, query.file),
        { sinceMs: query.sinceMs, budgetBytes: query.budgetBytes ?? LOG_BUDGET_BYTES },
        (raw, at) => {
            if (!atLeastLevel(raw, floor) || (needle !== undefined && !raw.toLowerCase().includes(needle))) {
                return;
            }
            const line = parseRecord(raw);
            if (line === undefined || (query.where !== undefined && !query.where(line))) {
                return;
            }
            matched += 1;
            if (lines.length < query.limit) {
                lines.push(line);
            }
            groupLine(groups, line, at);
        },
    );
    return {
        lines,
        matched,
        groups: [...groups.values()].toSorted((a, b) => b.count - a.count),
        coverage,
        readBytes: coverage.readBytes,
        windowTruncated: coverage.ended === "budget",
    };
};

// ---- slow spans ----

// `git.run` is that span alone (not git.run.wait); `git.` or `git.*` is every span under it.
export const opMatches = (op: string, perf: string): boolean => {
    if (op.endsWith("*") || op.endsWith(".")) {
        return perf.startsWith(op.replace(/\*$/, ""));
    }
    return perf === op;
};

// What a span was about, for splitting one op by its subject: the route of a request (ids folded), the git subcommand,
// the tool of a hook, the model role, else the repository.
const subjectOf = (span: JsonObject): string | undefined => {
    const path = span["path"];
    if (isText(path)) {
        return `${isText(span["method"]) ? `${span["method"]} ` : ""}${path.split("?")[0]?.replaceAll(/\/[^/]*\d[^/]*/g, "/:id")}`;
    }
    const git = span["git"];
    if (isText(git)) {
        return git.split(" ")[0];
    }
    const subject = span["tool"] ?? span["role"] ?? span["repo"] ?? span["frame"];
    return isText(subject) ? subject : undefined;
};

export type SpanGrouping = "op" | "op+path";

export interface SpanGroup {
    readonly key: string;
    readonly count: number;
    readonly p50: number;
    readonly p95: number;
    readonly max: number;
    readonly totalMs: number;
    // The slowest span of the group, as written.
    readonly worst: JsonObject;
}

export interface SlowSpanResult extends LogLineResult {
    readonly spanGroups: readonly SpanGroup[];
}

export const readSlowSpans = async (
    historyRoot: string,
    query: { readonly sinceMs?: number | undefined; readonly op?: string | undefined; readonly groupBy: SpanGrouping; readonly limit: number },
): Promise<SlowSpanResult> => {
    const buckets = new Map<string, { durations: number[]; worst: JsonObject; worstMs: number }>();
    const op = query.op;
    const result = await readLogLines(historyRoot, {
        file: "perf.jsonl",
        sinceMs: query.sinceMs,
        limit: query.limit,
        where: (span) => {
            // perf.jsonl also holds the ranked perf summary every 10 minutes; only lines naming a span are spans.
            if (!isText(span["perf"])) {
                return false;
            }
            const name = span["perf"];
            if (op !== undefined && !opMatches(op, name)) {
                return false;
            }
            const subject = query.groupBy === "op+path" ? subjectOf(span) : undefined;
            const key = subject === undefined ? name : `${name} ${subject}`;
            const ms = isFiniteNumber(span["ms"]) ? span["ms"] : 0;
            const bucket = buckets.get(key);
            if (bucket === undefined) {
                buckets.set(key, { durations: [ms], worst: span, worstMs: ms });
            } else {
                bucket.durations.push(ms);
                if (ms > bucket.worstMs) {
                    bucket.worst = span;
                    bucket.worstMs = ms;
                }
            }
            return true;
        },
    });
    const spanGroups = [...buckets.entries()]
        .map(([key, bucket]) => {
            const ascending = bucket.durations.toSorted((a, b) => a - b);
            const totalMs = ascending.reduce((total, ms) => total + ms, 0);
            return { key, count: ascending.length, p50: quantile(ascending, 0.5), p95: quantile(ascending, 0.95), max: bucket.worstMs, totalMs, worst: bucket.worst };
        })
        // Total time spent, which is what a slow machine is made of: many medium spans outrank one long one.
        .toSorted((a, b) => b.totalMs - a.totalMs);
    return { ...result, spanGroups };
};

// ---- the resource series ----

// One field of the resource series, picked by dotted path so any nested field (event loop delay, OOM kills, per-role
// memory) is reachable without enumerating them upfront.
export interface MetricPoint {
    readonly at: string;
    readonly value: number;
}

export interface MetricSeries {
    readonly field: string;
    // Oldest first. When the window holds more samples than the limit, each point is the largest of an even slice of
    // them (`bucketSize` samples), stamped at the slice's first: the peaks a diagnosis looks for survive the thinning.
    readonly points: readonly MetricPoint[];
    readonly bucketSize: number;
    // Every numeric sample in the window, not only the points returned.
    readonly samples: number;
    // Over every sample in the window; undefined (not zero) when nothing matched.
    readonly min: number | undefined;
    readonly max: number | undefined;
    readonly mean: number | undefined;
    // Samples in the window that lacked a number at this path, e.g. from a misspelled path.
    readonly missing: number;
    // The newest sample's value at the path when it is not a number (an object, a list), for showing as it stands.
    readonly latest: { readonly at: string; readonly value: unknown } | undefined;
    // When the path is absent from the newest sample: the deepest part of it that exists, and the keys found there.
    readonly nearest: { readonly path: string; readonly keys: readonly string[] } | undefined;
    readonly coverage: ScanCoverage;
}

// Walks a dotted path through nested plain objects; arrays are never indexed.
const valueAt = (source: JsonObject, path: readonly string[]): unknown =>
    path.reduce<unknown>((value, key) => (isJsonObject(value) ? value[key] : undefined), source);

const nearestOf = (sample: JsonObject, path: readonly string[]) => {
    let depth = path.length;
    while (depth > 0 && valueAt(sample, path.slice(0, depth)) === undefined) {
        depth -= 1;
    }
    const found = valueAt(sample, path.slice(0, depth));
    return { path: path.slice(0, depth).join("."), keys: isJsonObject(found) || Array.isArray(found) ? Object.keys(found) : [] };
};

const thin = (points: readonly MetricPoint[], limit: number) => {
    if (points.length <= limit) {
        return { points: [...points], bucketSize: 1 };
    }
    const bucketSize = Math.ceil(points.length / limit);
    const thinned: MetricPoint[] = [];
    for (let start = 0; start < points.length; start += bucketSize) {
        const slice = points.slice(start, start + bucketSize);
        thinned.push({ at: slice[0]?.at ?? "", value: Math.max(...slice.map((point) => point.value)) });
    }
    return { points: thinned, bucketSize };
};

export const readMetricSeries = async (
    historyRoot: string,
    query: { readonly field: string; readonly sinceMs?: number | undefined; readonly limit: number; readonly budgetBytes?: number | undefined },
): Promise<MetricSeries> => {
    const path = query.field.split(".").filter((part) => part !== "");
    const newestFirst: MetricPoint[] = [];
    let missing = 0;
    let newest: { readonly at: string; readonly sample: JsonObject } | undefined;
    const coverage = await scanNewestFirst(
        [join(logsRoot(historyRoot), "resource-metrics.jsonl")],
        { sinceMs: query.sinceMs, budgetBytes: query.budgetBytes ?? SERIES_BUDGET_BYTES },
        (raw) => {
            const sample = parseRecord(raw);
            const stamp = sample?.["at"];
            if (sample === undefined || !isText(stamp)) {
                return;
            }
            newest ??= { at: stamp, sample };
            const value = valueAt(sample, path);
            if (!isFiniteNumber(value)) {
                missing += 1;
                return;
            }
            newestFirst.push({ at: stamp, value });
        },
    );
    const base = { field: query.field, missing, coverage, latest: undefined, nearest: undefined };
    if (newestFirst.length === 0) {
        const empty = { ...base, points: [], bucketSize: 1, samples: 0, min: undefined, max: undefined, mean: undefined };
        if (newest === undefined) {
            return empty;
        }
        const latest = valueAt(newest.sample, path);
        return latest === undefined ? { ...empty, nearest: nearestOf(newest.sample, path) } : { ...empty, latest: { at: newest.at, value: latest } };
    }
    const values = newestFirst.map((point) => point.value);
    const { points, bucketSize } = thin(newestFirst.toReversed(), query.limit);
    return {
        ...base,
        points,
        bucketSize,
        samples: values.length,
        min: values.reduce((low, value) => Math.min(low, value)),
        max: values.reduce((high, value) => Math.max(high, value)),
        mean: Math.round((values.reduce((total, value) => total + value, 0) / values.length) * 1000) / 1000,
    };
};
