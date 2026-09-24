import type { Reading } from "../baseline.js";

/** A metric that did not read the same in every run, with each run's value in run order. */
export interface Disagreement {
    readonly metric: string;
    readonly values: readonly (number | undefined)[];
}

/** Every metric whose value differs between any two runs; a metric missing from one run differs too. */
export const disagreements = (runs: readonly Reading[]): readonly Disagreement[] =>
    [...new Set(runs.flatMap((run) => Object.keys(run)))].toSorted().flatMap((metric) => {
        const values = runs.map((run) => run[metric]);
        return values.every((value) => value === values[0]) ? [] : [{ metric, values }];
    });

/** One line per disagreement, `scenario metric: a, b, c`, with `—` for a run that did not report the metric. */
export const describeDisagreements = (scenario: string, found: readonly Disagreement[]): string =>
    found
        .map(({ metric, values }) => `${scenario} ${metric}: ${values.map((value) => (value === undefined ? "—" : String(value))).join(", ")}`)
        .join("\n");
