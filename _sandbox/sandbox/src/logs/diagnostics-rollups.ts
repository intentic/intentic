import { parseJsonOr } from "@intentic/base/json";
import { BUCKETS, addStored, HISTOGRAM_VERSION, histogramQuantile, roundMs } from "../system/resources/rollups/perf-histogram.js";
import { alignToWindow, PERF_ROLLUPS_FILE, type RollupRow, rollupRowSchema } from "../system/resources/rollups/perf-rollup.js";
import { logPaths, opMatches, type SpanGrouping } from "./diagnostics.js";
import { type ScanCoverage, scanNewestFirst } from "./log-read.js";

// Reads the perf rollups back (system/resources/perf-rollup.ts): every span the daemon timed, slow or not, as ten-minute
// histograms per op and subject. Rows of one key are added bucket by bucket across windows and boots, so the
// percentiles of a day or a fortnight are read off one merged histogram rather than averaged from per-window ones.

// The rollups run up to 4 MB a day and keep two weeks, most of it compressed (log-files.ts ARCHIVED); every window of
// them stays reachable.
const ROLLUP_BUDGET_BYTES = 64_000_000;

export interface RollupGroup {
    readonly key: string;
    readonly count: number;
    readonly totalMs: number;
    readonly failed: number;
    readonly p50: number;
    readonly p90: number;
    readonly p99: number;
    readonly max: number;
}

export interface RollupResult {
    // Most total time first.
    readonly groups: readonly RollupGroup[];
    // Spans counted across every matching row.
    readonly spans: number;
    // Distinct windows with a matching row, and the rows themselves (two boots can each write one for the same window).
    readonly windows: number;
    readonly rows: number;
    // Rows that did not parse, or whose histogram is of another version, left out rather than misread.
    readonly skipped: number;
    // The window's start moved back to the rollup window it falls in: rows cover whole windows.
    readonly sinceMs: number | undefined;
    readonly coverage: ScanCoverage;
}

interface Merged {
    count: number;
    totalMs: number;
    failed: number;
    minMs: number;
    maxMs: number;
    readonly buckets: Float64Array;
}

const keyOf = (row: RollupRow, groupBy: SpanGrouping): string => (groupBy === "op+path" && row.subject !== undefined ? `${row.op} ${row.subject}` : row.op);

const mergeRow = (groups: Map<string, Merged>, key: string, row: RollupRow): boolean => {
    const merged = groups.get(key) ?? { count: 0, totalMs: 0, failed: 0, minMs: Infinity, maxMs: 0, buckets: new Float64Array(BUCKETS) };
    if (!addStored(merged.buckets, row)) {
        return false;
    }
    merged.count += row.count;
    merged.totalMs += row.totalMs;
    merged.failed += row.failed ?? 0;
    merged.minMs = Math.min(merged.minMs, row.minMs);
    merged.maxMs = Math.max(merged.maxMs, row.maxMs);
    groups.set(key, merged);
    return true;
};

const groupOf = (key: string, merged: Merged): RollupGroup => {
    const at = (q: number): number => roundMs(histogramQuantile(merged.buckets, merged.count, q, merged.minMs, merged.maxMs));
    return { key, count: merged.count, totalMs: Math.round(merged.totalMs), failed: merged.failed, p50: at(0.5), p90: at(0.9), p99: at(0.99), max: merged.maxMs };
};

const parseRow = (raw: string): RollupRow | undefined => {
    const parsed = rollupRowSchema.safeParse(parseJsonOr(raw, undefined));
    return parsed.success && parsed.data.v === HISTOGRAM_VERSION ? parsed.data : undefined;
};

export const readRollups = async (
    historyRoot: string,
    query: { readonly sinceMs?: number | undefined; readonly op?: string | undefined; readonly groupBy: SpanGrouping },
): Promise<RollupResult> => {
    const sinceMs = query.sinceMs === undefined ? undefined : alignToWindow(query.sinceMs);
    const groups = new Map<string, Merged>();
    const windows = new Set<string>();
    let rows = 0;
    let skipped = 0;
    // A row names its op as `"op":"<name>"`; a line without the asked prefix is passed over before it is parsed.
    const needle = query.op === undefined ? undefined : `"op":"${query.op.replace(/\*$/, "")}`;
    const coverage = await scanNewestFirst(await logPaths(historyRoot, PERF_ROLLUPS_FILE), { sinceMs, budgetBytes: ROLLUP_BUDGET_BYTES }, (raw) => {
        if (needle !== undefined && !raw.includes(needle)) {
            return;
        }
        const row = parseRow(raw);
        if (row === undefined) {
            skipped += 1;
            return;
        }
        if (query.op !== undefined && !opMatches(query.op, row.op)) {
            return;
        }
        if (!mergeRow(groups, keyOf(row, query.groupBy), row)) {
            skipped += 1;
            return;
        }
        rows += 1;
        windows.add(row.at);
    });
    const ranked = [...groups].map(([key, merged]) => groupOf(key, merged)).toSorted((a, b) => b.totalMs - a.totalMs);
    return { groups: ranked, spans: ranked.reduce((total, group) => total + group.count, 0), windows: windows.size, rows, skipped, sinceMs, coverage };
};
