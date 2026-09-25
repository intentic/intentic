import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

/** One scenario's counts, metric name → count. */
export type Reading = Readonly<Record<string, number>>;

export interface Baseline {
    /** Where the counts were taken. A count is only judged against one taken under the same `runtime`. */
    readonly host: Readonly<Record<string, string>>;
    readonly scenarios: Readonly<Record<string, Reading>>;
}

export type Verdict = "same" | "within" | "regressed" | "improved" | "new" | "gone";

export interface Row {
    readonly scenario: string;
    readonly metric: string;
    readonly before: number | undefined;
    readonly after: number | undefined;
    /** (after − before) / before; 0 when either side is missing or before is 0 and after is too. */
    readonly delta: number;
    readonly verdict: Verdict;
}

/** Relative slack a metric is allowed before a move is a finding: 0 for a count that cannot jitter. */
export type Tolerance = (metric: string) => number;

// A row whose count no longer matches the baseline, in either direction. It is reported, never failed: a baseline that
// fails on every move is a golden master, re-recorded by whoever the red lands on until the numbers mean nothing.
const MOVED: ReadonlySet<Verdict> = new Set(["regressed", "improved", "new", "gone"]);

export const moved = (rows: readonly Row[]): readonly Row[] => rows.filter((row) => MOVED.has(row.verdict));

/**
 * A declared, one-directional claim about what the code costs: the only thing a perf run fails on. Each states the
 * property it protects and sits well above today's value, so it moves when the claim breaks and not when a count does.
 */
export interface Budget {
    readonly name: string;
    /** What stays true while the bound holds, and why the limit is where it is. */
    readonly claim: string;
    /** The scenarios it reads; a run that did not measure every one of them leaves it unjudged. */
    readonly reads: readonly string[];
    /** The bounded quantity, read from this run's measurements. */
    readonly value: (measured: Readonly<Record<string, Reading>>) => number;
    /** The value may not exceed this. */
    readonly max: number;
}

export interface BudgetResult {
    readonly budget: Budget;
    /** Undefined when a scenario it reads was not measured this run. */
    readonly value: number | undefined;
    readonly held: boolean;
}

/** Each budget against this run: held, broken, or unjudged when a scenario it reads was filtered out. */
export const judgeBudgets = (budgets: readonly Budget[], measured: Readonly<Record<string, Reading>>): readonly BudgetResult[] =>
    budgets.map((budget) => {
        if (!budget.reads.every((scenario) => measured[scenario] !== undefined)) {
            return { budget, value: undefined, held: true };
        }
        const value = budget.value(measured);
        return { budget, value, held: Number.isFinite(value) && value <= budget.max };
    });

const figure = (value: number): string => (Number.isInteger(value) ? value.toLocaleString("en-US") : value.toFixed(3));

const budgetLine = ({ budget, value, held }: BudgetResult): string => {
    if (value === undefined) {
        return `  – ${budget.name}: not judged, needs ${budget.reads.join(", ")}`;
    }
    return `  ${held ? "✓" : "✗"} ${budget.name}: ${figure(value)} ${held ? "≤" : ">"} ${figure(budget.max)}${held ? "" : `\n      ${budget.claim}`}`;
};

const deltaOf = (before: number, after: number): number => {
    if (before === after) {
        return 0;
    }
    return before === 0 ? Number.POSITIVE_INFINITY : (after - before) / before;
};

const verdictOf = (delta: number, tolerance: number): Verdict => {
    if (delta === 0) {
        return "same";
    }
    if (Math.abs(delta) <= tolerance) {
        return "within";
    }
    return delta > 0 ? "regressed" : "improved";
};

/**
 * Judges what was measured against the baseline. `complete` says every scenario was run, which is the only case in
 * which a baseline scenario absent from `measured` is `gone` rather than merely not asked for.
 */
export const judge = (baseline: Baseline, measured: Readonly<Record<string, Reading>>, tolerance: Tolerance, complete: boolean): readonly Row[] => {
    const rows: Row[] = [];
    const scenarios = new Set([...Object.keys(measured), ...(complete ? Object.keys(baseline.scenarios) : [])]);
    for (const scenario of [...scenarios].toSorted()) {
        const before = baseline.scenarios[scenario] ?? {};
        const after = measured[scenario] ?? {};
        for (const metric of [...new Set([...Object.keys(before), ...Object.keys(after)])].toSorted()) {
            const was = before[metric];
            const now = after[metric];
            if (was === undefined || now === undefined) {
                rows.push({ scenario, metric, before: was, after: now, delta: 0, verdict: was === undefined ? "new" : "gone" });
                continue;
            }
            const delta = deltaOf(was, now);
            rows.push({ scenario, metric, before: was, after: now, delta, verdict: verdictOf(delta, tolerance(metric)) });
        }
    }
    return rows;
};

/** The baseline with `measured` written over it; scenarios not measured this run are kept as they were. */
export const updated = (baseline: Baseline, measured: Readonly<Record<string, Reading>>, host: Baseline["host"], complete: boolean): Baseline => {
    const kept = complete ? {} : baseline.scenarios;
    const scenarios = { ...kept, ...measured };
    return {
        host,
        scenarios: Object.fromEntries(
            Object.keys(scenarios)
                .toSorted()
                .map((name) => [name, sortedKeys(scenarios[name]!)]),
        ),
    };
};

const sortedKeys = (reading: Reading): Reading =>
    Object.fromEntries(Object.entries(reading).toSorted(([left], [right]) => left.localeCompare(right)));

const readBaseline = (path: string): Baseline =>
    existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Baseline) : { host: {}, scenarios: {} };

const count = (value: number | undefined): string => (value === undefined ? "—" : value.toLocaleString("en-US"));

const percent = (delta: number): string => {
    if (!Number.isFinite(delta)) {
        return "+∞";
    }
    const fixed = (delta * 100).toFixed(Math.abs(delta) < 0.001 ? 4 : 2);
    return `${delta > 0 ? "+" : ""}${fixed}%`;
};

/** A plain-text table, one line per row; `quiet` drops the rows that match exactly. */
export const table = (rows: readonly Row[], quiet: boolean): string => {
    const shown = quiet ? rows.filter((row) => row.verdict !== "same") : rows;
    const cells = shown.map((row) => [
        row.scenario,
        row.metric,
        count(row.before),
        count(row.after),
        row.before === undefined || row.after === undefined || row.verdict === "same" ? "" : percent(row.delta),
        row.verdict,
    ]);
    const header = ["scenario", "metric", "baseline", "measured", "delta", "verdict"];
    const widths = header.map((title, column) => Math.max(title.length, ...cells.map((cell) => cell[column]!.length)));
    // Names read left-aligned and counts right-aligned, so a column of digits lines up by magnitude.
    const line = (cell: readonly string[]): string =>
        cell
            .map((text, column) => (column >= 2 && column <= 4 ? text.padStart(widths[column]!) : text.padEnd(widths[column]!)))
            .join("  ")
            .trimEnd();
    return [line(header), ...cells.map(line)].join("\n");
};

/** Host keys that differ between the baseline and this run. */
const hostDrift = (baseline: Baseline["host"], now: Baseline["host"]): readonly string[] =>
    [...new Set([...Object.keys(baseline), ...Object.keys(now)])].toSorted().filter((key) => baseline[key] !== now[key]);

export interface Run {
    readonly path: string;
    readonly measured: Readonly<Record<string, Reading>>;
    readonly host: Baseline["host"];
    readonly tolerance: Tolerance;
    readonly budgets: readonly Budget[];
    readonly update: boolean;
    /** Every scenario was measured, so one missing from `measured` is gone rather than filtered out. */
    readonly complete: boolean;
    /** Host keys whose change makes the counts incomparable with the baseline's: the diff is then shown, not read. */
    readonly binding: readonly string[];
    /** How this baseline is re-recorded, quoted wherever the diff says it moved. */
    readonly rerecord: string;
}

export interface Decision {
    /** False only when a declared budget is broken; a count that moved from the baseline is a report. */
    readonly ok: boolean;
    readonly text: string;
    /** The same report as markdown, for a CI job summary. */
    readonly summary: string;
    /** The baseline to write, on `update`. */
    readonly record?: Baseline;
}

/** Judges one run: its budgets decide, and its diff against `baseline` is reported. Re-records it when the run asks to. */
export const decide = (baseline: Baseline, run: Run): Decision => {
    const drift = hostDrift(baseline.host, run.host);
    const driftLines = drift.map((key) => `  ${key}: ${baseline.host[key] ?? "—"} → ${run.host[key] ?? "—"}`);
    const budgets = judgeBudgets(run.budgets, run.measured);
    const broken = budgets.filter((result) => !result.held);
    const budgetText = budgets.length === 0 ? "" : `\n\nbudgets:\n${budgets.map(budgetLine).join("\n")}`;
    const verdict = broken.length === 0 ? "" : `\n\n${broken.length} budget(s) broken: ${broken.map((result) => result.budget.name).join(", ")}`;
    const finish = (diff: string, note: string, record?: Baseline): Decision => {
        const text = `${diff}${note}${budgetText}${verdict}`;
        return { ok: broken.length === 0, text, summary: `\`\`\`\n${text}\n\`\`\``, ...(record === undefined ? {} : { record }) };
    };
    if (run.update) {
        const rows = judge(baseline, run.measured, () => 0, run.complete);
        const changed = rows.filter((row) => row.verdict !== "same").length;
        return finish(table(rows, true), `\n\nrecorded ${run.path} (${changed} of ${rows.length} counts moved)`, updated(baseline, run.measured, run.host, run.complete));
    }
    const rows = judge(baseline, run.measured, run.tolerance, run.complete);
    if (Object.keys(baseline.scenarios).length === 0) {
        return finish(table(rows, false), `\n\nno baseline at ${run.path} to compare with; record one: ${run.rerecord}`);
    }
    const incomparable = drift.filter((key) => run.binding.includes(key));
    if (incomparable.length > 0) {
        return finish(
            table(rows, true),
            `\n\nnot compared: the baseline was recorded under a different ${incomparable.join(", ")}, so these moves are the host's as much as the code's\n${driftLines.join("\n")}`,
        );
    }
    const shifted = moved(rows);
    const hostNote = drift.length > 0 ? `\n\nhost differs from the baseline's (counts may move by the host alone):\n${driftLines.join("\n")}` : "";
    if (shifted.length === 0) {
        return finish(table(rows, false), `${hostNote}\n\n${rows.length} counts match ${run.path}`);
    }
    return finish(
        table(rows, false),
        `${hostNote}\n\n${shifted.length} counts moved from ${run.path}: a report, not a failure. To record them: ${run.rerecord}`,
    );
};

/** The workflow that re-records the baselines and uploads the patch. */
export const RECORD_WORKFLOW = ".github/workflows/perf-record.yml";

/** How a track's baseline is re-recorded. */
export const rerecordOf = (track: "instr" | "browser"): string =>
    `run the Perf record workflow (${RECORD_WORKFLOW}, track ${track}) and apply the patch it uploads`;

/**
 * Why `--update` may not run here, or undefined where it may: only in the record workflow, on the runner class the
 * counts are judged on, so a baseline is never re-recorded on a laptop, in a sandbox, or by whoever a red run lands on.
 */
export const recordingRefusal = (env: Readonly<Record<string, string | undefined>>, rerecord: string): string | undefined =>
    env["GITHUB_WORKFLOW_REF"]?.includes(RECORD_WORKFLOW) === true
        ? undefined
        : `--update re-records a baseline, which only the record workflow does, on the CI runner class: ${rerecord}\n`;

/** Appends the report to the CI job summary, where there is one. */
export const publish = (title: string, decision: Decision, env: Readonly<Record<string, string | undefined>> = process.env): void => {
    const file = env["GITHUB_STEP_SUMMARY"];
    if (file !== undefined && file !== "") {
        appendFileSync(file, `### ${title}\n\n${decision.summary}\n\n`);
    }
};

/** `decide` against the baseline file at `run.path`, writing it back on update. */
export const conclude = (run: Run): Decision => {
    const decision = decide(readBaseline(run.path), run);
    if (decision.record !== undefined) {
        writeFileSync(run.path, `${JSON.stringify(decision.record, undefined, 4)}\n`);
    }
    return decision;
};
