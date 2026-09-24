import { existsSync, readFileSync, writeFileSync } from "node:fs";

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

// A verdict here means the checked-in numbers no longer describe the code, in either direction: an improvement left
// unrecorded is slack the next regression hides in.
const FAILING: ReadonlySet<Verdict> = new Set(["regressed", "improved", "new", "gone"]);

export const failing = (rows: readonly Row[]): readonly Row[] => rows.filter((row) => FAILING.has(row.verdict));

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
    readonly update: boolean;
    /** Every scenario was measured, so one missing from `measured` is gone rather than filtered out. */
    readonly complete: boolean;
    /** Host keys whose change makes every count incomparable (the runtime that executes the code under test). */
    readonly binding: readonly string[];
    /** The command that re-records this baseline, quoted in every failure. */
    readonly rerecord: string;
}

export interface Decision {
    /** False when the baseline no longer describes the code. */
    readonly ok: boolean;
    readonly text: string;
    /** The baseline to write, on `update`. */
    readonly record?: Baseline;
}

/** Judges one run against `baseline`, or re-records it when the run asks to. */
export const decide = (baseline: Baseline, run: Run): Decision => {
    const drift = hostDrift(baseline.host, run.host);
    const driftLines = drift.map((key) => `  ${key}: ${baseline.host[key] ?? "—"} → ${run.host[key] ?? "—"}`);
    if (run.update) {
        const rows = judge(baseline, run.measured, () => 0, run.complete);
        const moved = rows.filter((row) => row.verdict !== "same").length;
        return {
            ok: true,
            text: `${table(rows, true)}\n\nrecorded ${run.path} (${moved} of ${rows.length} counts moved)`,
            record: updated(baseline, run.measured, run.host, run.complete),
        };
    }
    const rows = judge(baseline, run.measured, run.tolerance, run.complete);
    if (Object.keys(baseline.scenarios).length === 0) {
        return { ok: false, text: `${table(rows, false)}\n\nno baseline at ${run.path}; record one: ${run.rerecord}` };
    }
    if (drift.some((key) => run.binding.includes(key))) {
        return {
            ok: false,
            text: `${table(rows, false)}\n\nnot judged: the baseline was recorded under a different runtime\n${driftLines.join("\n")}\nre-record: ${run.rerecord}`,
        };
    }
    const failed = failing(rows);
    const hostNote = drift.length > 0 ? `\n\nhost differs from the baseline's (counts may move by the host alone):\n${driftLines.join("\n")}` : "";
    if (failed.length === 0) {
        return { ok: true, text: `${table(rows, false)}${hostNote}\n\n${rows.length} counts match ${run.path}` };
    }
    const improvedOnly = failed.every((row) => row.verdict === "improved");
    const advice = improvedOnly ? "cheaper than recorded: lock it in" : "if the change is intended, re-record and commit the baseline diff";
    return { ok: false, text: `${table(rows, false)}${hostNote}\n\n${failed.length} counts moved past tolerance; ${advice}: ${run.rerecord}` };
};

/** `decide` against the baseline file at `run.path`, writing it back on update. */
export const conclude = (run: Run): Decision => {
    const decision = decide(readBaseline(run.path), run);
    if (decision.record !== undefined) {
        writeFileSync(run.path, `${JSON.stringify(decision.record, undefined, 4)}\n`);
    }
    return decision;
};
