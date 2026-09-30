import type { TurnExperiment, TurnMetricReading } from "@intentic/sandbox-contract";

// One experiment as a results table: every reading is a row of the same shape, so a measured win lands in the same
// column whichever reading it is. The old split into a headline and footnotes put the same kind of finding in two
// places, and a win on the second reading read as small print under a "No effect".

/** What the two groups are counted in; the sample row's name. */
export type SampleUnit = `conversations` | `turns` | `commands`;

/** The metrics a row can be, named by the daemon's reading plus the cleaners' own. */
export type RowKey = TurnMetricReading["metric"] | `outputReached`;

/** What one row concluded, in words a reader already has; the arithmetic behind it rides along for the hover note. */
export type Outcome =
    // Only once the daemon's margin excludes zero. `low`/`high` bound the likely size of the change, in whole percent.
    | { readonly kind: `lower` | `higher`; readonly pct: number; readonly low?: number; readonly high?: number; readonly saved?: number }
    // Enough data on both sides, and any difference is still inside the noise: `within` is how big it could be.
    | { readonly kind: `unclear`; readonly within?: number; readonly needed?: number }
    // Too few samples on one side for any answer yet.
    | { readonly kind: `early` };

export interface ResultRow {
    readonly key: RowKey;
    /** Each group's average, when the metric has one; the cleaners compare shares and have none. */
    readonly on?: number;
    readonly off?: number;
    readonly outcome: Outcome;
}

export interface ResultTable {
    readonly unit: SampleUnit;
    /** How many samples each group holds. */
    readonly on: number;
    readonly off: number;
    /** Samples each group needs before any row can answer; absent when the experiment publishes no threshold. */
    readonly minimum?: number;
    readonly rows: readonly ResultRow[];
}

const whole = (value: number): number => Math.round(Math.abs(value));

export const outcomeOf = (reading: TurnMetricReading): Outcome => {
    if (reading.marginPct === undefined) {
        return { kind: `early` };
    }
    if (reading.deltaPct === undefined) {
        return {
            kind: `unclear`,
            within: whole(reading.marginPct),
            ...(reading.controlTurnsNeeded === undefined ? {} : { needed: reading.controlTurnsNeeded }),
        };
    }
    // The likely range of the change, as the two ends a reader can say out loud ("34 to 93% fewer"), rather than a
    // centre and a ± in percentage points. Clamped at zero: the daemon only publishes a delta whose margin excludes it.
    const size = Math.abs(reading.deltaPct);
    return {
        kind: reading.deltaPct < 0 ? `lower` : `higher`,
        pct: whole(reading.deltaPct),
        low: whole(Math.max(0, size - reading.marginPct)),
        high: whole(size + reading.marginPct),
        ...(reading.saved !== undefined && reading.saved > 0 ? { saved: Math.round(reading.saved) } : {}),
    };
};

// An opening turn is one per conversation, so the reader counts conversations either way.
const unitOf = (experiment: TurnExperiment): SampleUnit => (experiment.sampleUnit === `turns` || experiment.sampleUnit === undefined ? `turns` : `conversations`);

/** Undefined until the daemon has an experiment to report, which the panel says in words. */
export const tableOf = (experiment: TurnExperiment | undefined): ResultTable | undefined => {
    if (experiment === undefined) {
        return undefined;
    }
    // Every reading is over the same coin flip, so the first one's group sizes are every row's.
    const [first] = experiment.metrics;
    return {
        unit: unitOf(experiment),
        on: first.on.turns,
        off: first.off.turns,
        minimum: experiment.minTurns,
        rows: experiment.metrics.map((reading) => ({ key: reading.metric, on: reading.on.mean, off: reading.off.mean, outcome: outcomeOf(reading) })),
    };
};

/** How many more samples the smaller group needs before rows can answer; 0 once both have enough. */
export const shortfallOf = (table: ResultTable): number => (table.minimum === undefined ? 0 : Math.max(0, table.minimum - Math.min(table.on, table.off)));
