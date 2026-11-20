import { parseLink } from "./link.js";
import type { RunFile, RunResult } from "./results.js";

// `--compare`: a run against the checked-in baseline and the stream's budgets (budgets.json), as one table each. A lab,
// so nothing here decides an exit code by itself; the CLI fails only when asked to (`--strict`).

export interface Budget {
    readonly id: string;
    // What a person would defend, in words: the reason the number is what it is.
    readonly claim: string;
    readonly workload: string;
    // A link's name, or "*" for every link the run measured.
    readonly link: string;
    // A dotted path into a run's result: `encoderCores`, `latencyMs.p50`, `uniqueFps.mean` (METRICS).
    readonly metric: MetricPath;
    readonly max?: number;
    readonly min?: number;
    // The limit is the link's added round trip plus `max`: a keystroke cannot come back faster than the link allows.
    readonly plusRtt?: boolean;
}

export interface Verdict {
    readonly budget: Budget;
    readonly pipeline: string;
    readonly link: string;
    readonly value: number | null;
    readonly limit: number;
    // Null when the run has no reading for it (a workload or link not run, a metric the pipeline could not measure).
    readonly pass: boolean | null;
}

// Every number a budget or the comparison can name, by the dotted path budgets.json spells it with.
export const METRICS = {
    encoderCores: (run) => run.encoderCores,
    xvfbCores: (run) => run.xvfbCores,
    chromiumCores: (run) => run.chromiumCores,
    framesPerSec: (run) => run.framesPerSec,
    "uniqueFps.mean": (run) => run.uniqueFps.mean,
    "uniqueFps.min": (run) => run.uniqueFps.min,
    mbps: (run) => run.mbps,
    "latencyMs.p50": (run) => run.latencyMs.p50,
    "latencyMs.p99": (run) => run.latencyMs.p99,
    "displayMs.p50": (run) => run.displayMs.p50,
    "pipelineMs.p50": (run) => run.pipelineMs.p50,
    "pipelineMs.p99": (run) => run.pipelineMs.p99,
    stalls: (run) => run.stalls,
    maxGapMs: (run) => run.maxGapMs,
    "keyMs.p50": (run) => run.keyMs.p50,
    "keyMs.p99": (run) => run.keyMs.p99,
    "pasteMs.p50": (run) => run.pasteMs.p50,
    "pasteMs.max": (run) => run.pasteMs.max,
} as const satisfies Record<string, (run: RunResult) => number | null>;

export type MetricPath = keyof typeof METRICS;

const isMetric = (path: string): path is MetricPath => Object.hasOwn(METRICS, path);

export const metricOf = (run: RunResult, path: MetricPath): number | null => METRICS[path](run);

// A budget as budgets.json spells it, before its metric is known to be one castbench measures.
export type BudgetInput = Omit<Budget, "metric"> & { readonly metric: string };

export interface BudgetsInput {
    readonly budgets?: readonly BudgetInput[];
}

// budgets.json as read from disk: every budget must name a metric this file knows, or the file is refused whole rather
// than a budget quietly judging nothing.
export const parseBudgets = (file: BudgetsInput): Budget[] =>
    (file.budgets ?? []).map((budget) => {
        if (!isMetric(budget.metric)) {
            throw new Error(`budget ${budget.id} names no metric castbench measures: ${budget.metric}`);
        }
        if ((budget.max === undefined) === (budget.min === undefined)) {
            throw new Error(`budget ${budget.id} must set exactly one of max and min`);
        }
        return { ...budget, metric: budget.metric };
    });

// The limit a budget sets on `link`.
export const limitOf = (budget: Budget, link: string): number => {
    const bound = budget.max ?? budget.min ?? 0;
    return budget.plusRtt === true ? bound + parseLink(link).rttMs : bound;
};

// Every budget against every run it names: one verdict per budget, pipeline and link.
export const judge = (runs: readonly RunResult[], budgets: readonly Budget[]): Verdict[] =>
    budgets.flatMap((budget) =>
        runs
            .filter((run) => run.workload === budget.workload && (budget.link === "*" || budget.link === run.link))
            .map((run) => {
                const value = metricOf(run, budget.metric);
                const limit = limitOf(budget, run.link);
                const pass = value === null ? null : budget.max === undefined ? value >= limit : value <= limit;
                return { budget, pipeline: run.pipeline, link: run.link, value, limit, pass };
            }),
    );

interface MetricRow {
    readonly path: MetricPath;
    readonly label: string;
    // The workloads it means anything on: latency needs a moving marker, a keystroke needs the typing page.
    readonly workloads: readonly string[];
}

const MOVING = ["anim", "scroll", "flood"];
const ALL = ["still", "anim", "scroll", "typing", "flood"];

const COMPARED_METRICS: readonly MetricRow[] = [
    { path: "encoderCores", label: "encoder cores", workloads: ALL },
    { path: "xvfbCores", label: "Xvfb cores", workloads: ALL },
    { path: "framesPerSec", label: "frames/s on the wire", workloads: ALL },
    { path: "uniqueFps.mean", label: "unique fps", workloads: MOVING },
    { path: "mbps", label: "Mbit/s", workloads: ALL },
    { path: "latencyMs.p50", label: "drawn→decoded p50 ms", workloads: MOVING },
    { path: "latencyMs.p99", label: "drawn→decoded p99 ms", workloads: MOVING },
    { path: "pipelineMs.p50", label: "display→decoded p50 ms", workloads: MOVING },
    { path: "stalls", label: "stalls", workloads: MOVING },
    { path: "keyMs.p50", label: "key→glyph p50 ms", workloads: ["typing"] },
    { path: "keyMs.p99", label: "key→glyph p99 ms", workloads: ["typing"] },
    { path: "pasteMs.max", label: "10k paste ms (worst)", workloads: ["typing"] },
];

const shown = (value: number | null): string => (value === null ? "—" : String(value));

// The change from baseline to run, as a signed percentage; blank where either is missing or the baseline is zero.
export const changeOf = (run: number | null, baseline: number | null): string => {
    if (run === null || baseline === null) {
        return "";
    }
    if (baseline === 0) {
        return run === 0 ? "0%" : "";
    }
    const percent = Math.round(((run - baseline) / Math.abs(baseline)) * 100);
    return `${percent > 0 ? "+" : ""}${percent}%`;
};

// Columns padded to their widest cell, the first left-aligned and the rest right-aligned.
export const renderTable = (header: readonly string[], rows: readonly (readonly string[])[]): string => {
    const widths = header.map((cell, column) => Math.max(cell.length, ...rows.map((row) => (row[column] ?? "").length)));
    const line = (row: readonly string[]): string =>
        row
            .map((cell, column) => (column <= 2 ? cell.padEnd(widths[column]!) : cell.padStart(widths[column]!)))
            .join("  ")
            .trimEnd();
    return [line(header), line(widths.map((width) => "-".repeat(width))), ...rows.map(line)].join("\n");
};

// The baseline's run for the same workload and link: compared across pipelines on purpose, since castd is judged
// against today's.
const counterpart = (baseline: RunFile | undefined, run: RunResult): RunResult | undefined =>
    baseline?.runs.find((candidate) => candidate.workload === run.workload && candidate.link === run.link);

export const compareTable = (current: RunFile, baseline: RunFile | undefined): string => {
    const rows: string[][] = [];
    for (const run of current.runs) {
        const before = counterpart(baseline, run);
        for (const metric of COMPARED_METRICS.filter((row) => row.workloads.includes(run.workload))) {
            const now = metricOf(run, metric.path);
            const then = before === undefined ? null : metricOf(before, metric.path);
            rows.push([run.workload, run.link, metric.label, `${shown(now)}`, shown(then), changeOf(now, then)]);
        }
    }
    const header = ["workload", "link", "metric", current.runs[0]?.pipeline ?? "run", baseline === undefined ? "baseline" : `baseline (${baseline.runs[0]?.pipeline ?? "?"})`, "Δ"];
    return renderTable(header, rows);
};

export const verdictTable = (verdicts: readonly Verdict[]): string =>
    renderTable(
        ["budget", "link", "pipeline", "value", "limit", "verdict"],
        verdicts.map((verdict) => [
            verdict.budget.id,
            verdict.link,
            verdict.pipeline,
            shown(verdict.value),
            `${verdict.budget.max === undefined ? "≥" : "≤"} ${verdict.limit}`,
            verdict.pass === null ? "no reading" : verdict.pass ? "pass" : "FAIL",
        ]),
    );
