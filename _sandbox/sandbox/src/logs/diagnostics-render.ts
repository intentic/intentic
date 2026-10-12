import { basename } from "node:path";
import { isJsonObject } from "../store/evolution/conversions.js";
import { capLines, compactRecord } from "./diagnostics-shape.js";
import type { LevelName, LogLineResult, MetricSeries, SlowSpanResult } from "./diagnostics.js";
import type { RestartsResult, TimelineResult } from "./diagnostics-history.js";
import type { ScanCoverage } from "./log-read.js";

// The diagnostics tools' answers as text. Every answer says what it searched (file, window, level) and how far back the
// file actually reaches, so an empty one can be told from one that could not see far enough: "No lines in that window"
// alone was read as "nothing happened" when the window had rotated away.

// One answer's size: a sixty-line read once came back at 83 KB, most of a context window.
export const MAX_ANSWER_CHARS = 30_000;
// A non-numeric metric shown whole up to this; past it, only its keys.
const SUBTREE_CHARS = 6_000;

const iso = (at: number): string => new Date(at).toISOString();

export interface Window {
    readonly sinceMs?: number | undefined;
    readonly now: number;
}

export const windowText = (window: Window): string =>
    window.sinceMs === undefined ? "in everything kept" : `between ${iso(window.sinceMs)} and ${iso(window.now)}`;

const levelText = (level: LevelName | undefined): string => (level === undefined || level === "trace" ? "" : level === "fatal" ? "fatal " : `${level}-or-worse `);

/** How far the read reached: the files it walked, the time span they cover, and whether anything in the window went unread. */
export const reachText = (coverage: ScanCoverage, window: Window, file: string): string => {
    if (coverage.files.length === 0) {
        return `${file} does not exist yet.`;
    }
    const names = coverage.files.map((path) => basename(path)).join(" and ");
    if (coverage.oldestAt === undefined || coverage.newestAt === undefined) {
        return `${names} holds no timestamped lines.`;
    }
    const span = `${iso(coverage.oldestAt)} to ${iso(coverage.newestAt)}`;
    switch (coverage.ended) {
        case "window":
            return `Read ${names} back past the window's start; it reaches further back.`;
        case "budget":
            return `Read the newest ${(coverage.readBytes / 1_000_000).toFixed(1)} MB of ${names} (${span}); the window reaches further, and older lines were not read.`;
        default:
            return window.sinceMs !== undefined && window.sinceMs < coverage.oldestAt
                ? `${names} holds lines from ${span} only: the window starts before the oldest line kept, and anything earlier has rotated away.`
                : `${names} holds lines from ${span}.`;
    }
};

// `tail`: rows run oldest to newest, so the cap drops the oldest rather than the newest.
const capped = (head: readonly string[], rows: readonly string[], tail = false): string => {
    const budget = MAX_ANSWER_CHARS - head.join("\n").length;
    const fitted = capLines(tail ? rows.toReversed() : rows, budget);
    const { dropped } = fitted;
    const kept = tail ? fitted.kept.toReversed() : fitted.kept;
    return [
        ...head,
        ...kept,
        ...(dropped > 0 ? [`… ${dropped} more not shown: answers are capped at ${MAX_ANSWER_CHARS / 1000} KB. Narrow the window or \`contains\`, or group.`] : []),
    ].join("\n");
};

const repeatsText = (result: LogLineResult): string[] => {
    const heavy = result.groups.filter((group) => group.count >= 5).slice(0, 3);
    return result.matched > 10 && heavy.length > 0 ? [`Most repeated: ${heavy.map((group) => `${group.count}× "${group.template}"`).join("; ")}.`] : [];
};

export interface LinesView {
    readonly what: string;
    readonly file: string;
    readonly level?: LevelName | undefined;
    readonly window: Window;
    readonly group: boolean | undefined;
    readonly stacks: boolean;
    readonly limit: number;
}

export const renderLines = (result: LogLineResult, view: LinesView): string => {
    const searched = `${levelText(view.level)}${view.what} in ${view.file} ${windowText(view.window)}`;
    const reach = reachText(result.coverage, view.window, view.file);
    if (result.matched === 0) {
        return `No ${searched}. ${reach}`;
    }
    const grouped = view.group ?? result.matched > view.limit;
    if (grouped) {
        const groups = result.groups.slice(0, view.limit);
        return capped(
            [
                `${result.matched} ${searched}, as ${result.groups.length} kinds of message (ids and numbers folded), most frequent first${groups.length < result.groups.length ? `; the top ${groups.length}` : ""}. ${reach}`,
                "",
            ],
            groups.map((group) => {
                const when = group.oldestAt === undefined || group.newestAt === undefined ? "" : ` first ${iso(group.oldestAt)} last ${iso(group.newestAt)}`;
                return `${group.count}×${when} e.g. ${JSON.stringify(compactRecord(group.example, view.stacks))}`;
            }),
        );
    }
    const head =
        result.matched > result.lines.length
            ? `${result.matched} ${searched}; newest ${result.lines.length} below (raise \`limit\`, narrow the window, or \`group: true\` for the rest).`
            : `${result.matched} ${searched}, newest first.`;
    return capped(
        [head, reach, ...repeatsText(result), ""],
        result.lines.map((line) => JSON.stringify(compactRecord(line, view.stacks))),
    );
};

export const renderSpans = (result: SlowSpanResult, view: LinesView & { readonly grouping: string }): string => {
    if (result.matched === 0 || !(view.group ?? result.matched > view.limit)) {
        return renderLines(result, view);
    }
    const groups = result.spanGroups.slice(0, view.limit);
    return capped(
        [
            `${result.matched} ${view.what} in ${view.file} ${windowText(view.window)}, grouped by ${view.grouping} into ${result.spanGroups.length}, most total time first${groups.length < result.spanGroups.length ? `; the top ${groups.length}` : ""}. ${reachText(result.coverage, view.window, view.file)}`,
            "",
        ],
        groups.map((group) => {
            const { perf: _perf, message: _message, level: _level, seen: _seen, slowSeen: _slowSeen, ...worst } = compactRecord(group.worst, false);
            return `${group.key}: ${group.count}×, p50 ${group.p50} ms, p95 ${group.p95} ms, max ${group.max} ms; worst ${JSON.stringify(worst)}`;
        }),
    );
};

const subtreeText = (value: unknown): string => {
    const whole = JSON.stringify(value);
    if (whole.length <= SUBTREE_CHARS) {
        return whole;
    }
    return isJsonObject(value)
        ? `(${whole.length} characters; its keys) ${Object.keys(value).join(", ")}`
        : `${whole.slice(0, SUBTREE_CHARS)}…`;
};

export const renderSeries = (series: MetricSeries, window: Window): string => {
    const field = series.field;
    if (series.latest !== undefined) {
        return [
            `\`${field}\` is ${Array.isArray(series.latest.value) ? "a list" : isJsonObject(series.latest.value) ? "an object" : "not a number"}, so here is its value in the newest sample (${series.latest.at}); name a numeric field under it for a series.`,
            "",
            subtreeText(series.latest.value),
        ].join("\n");
    }
    if (series.nearest !== undefined) {
        const at = series.nearest.path === "" ? "At the top level" : `\`${series.nearest.path}\` exists; under it`;
        return `No \`${field}\` in the newest sample, and none in ${series.missing} samples ${windowText(window)}. ${at} the keys are: ${series.nearest.keys.join(", ")}.`;
    }
    if (series.points.length === 0) {
        return `No samples ${windowText(window)}. ${reachText(series.coverage, window, "resource-metrics.jsonl")}`;
    }
    const cut =
        window.sinceMs !== undefined && series.coverage.oldestAt !== undefined && series.coverage.ended !== "window" && series.coverage.oldestAt > window.sinceMs + 120_000
            ? [reachText(series.coverage, window, "resource-metrics.jsonl")]
            : [];
    return [
        `${field}: ${series.samples} samples ${windowText(window)}, min ${series.min}, mean ${series.mean}, max ${series.max} (over all of them).`,
        ...cut,
        ...(series.bucketSize > 1 ? [`Each row is the largest of ${series.bucketSize} consecutive samples, stamped at the first.`] : []),
        "",
        ...series.points.map((point) => `${point.at} ${point.value}`),
    ].join("\n");
};

export const renderRestarts = (result: RestartsResult, window: Window, limit: number): string => {
    if (result.rows.length === 0) {
        return `No daemon boots ${windowText(window)} in ${result.source === "restarts.jsonl" ? "logs/restarts.jsonl" : "boot-history.json or the resource series"}.`;
    }
    const shown = result.rows.slice(0, limit);
    return [
        `${result.rows.length} daemon boots ${windowText(window)}, newest first${shown.length < result.rows.length ? `; the newest ${shown.length}` : ""}.`,
        ...(result.source === "boot-history" ? ["This daemon keeps no restart log yet: boot times come from boot-history.json and where the resource series' uptime starts over."] : []),
        "",
        ...shown.map((row) => `${iso(row.at)} ${row.text}`),
    ].join("\n");
};

export const renderTimeline = (result: TimelineResult, conversationId: string, window: Window): string => {
    const total = result.found.log + result.found.activity + result.found.turn + result.found.boot;
    const reach = reachText(result.logCoverage, window, "daemon.log");
    if (total === 0) {
        return `Nothing names ${conversationId} ${windowText(window)} in daemon.log, activity.jsonl or the turn ledger. ${reach} Check the id with \`agents show ${conversationId}\`.`;
    }
    const shown = result.events.length;
    return capped(
        [
            `${conversationId} ${windowText(window)}: ${total} events (${result.found.log} daemon.log lines, ${result.found.activity} activity entries, ${result.found.turn} turns, ${result.found.boot} daemon boots)${shown < total ? `; the newest ${shown}` : ""}, oldest first. ${reach} What was said is in \`agents show ${conversationId} --transcript\`.`,
            "",
        ],
        result.events.map((event) => `${iso(event.at)} ${event.source.padEnd(8)} ${event.text}`),
        true,
    );
};
