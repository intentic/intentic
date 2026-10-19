import type { TurnExperiment, TurnMetricReading } from "@intentic/sandbox-contract/schemas/settings";

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
    // Too few samples on one side for any answer yet: `have` is what the smaller group holds, `need` what each needs.
    | { readonly kind: `early`; readonly have?: number; readonly need?: number };

export interface ResultRow {
    readonly key: RowKey;
    /** Each group's average, when the metric has one; the cleaners compare shares and have none. */
    readonly on?: number;
    readonly off?: number;
    /** The averages are shares of the sample, 0 to 1, said as percentages. */
    readonly share?: boolean;
    /** The averages are token counts, said compactly ("83k") rather than to a tenth. */
    readonly tokens?: boolean;
    /**
     * The samples behind this row, which can be fewer than the table's: the calls before the edited file are read only
     * on turns that edited something.
     */
    readonly samples?: { readonly on: number; readonly off: number };
    readonly outcome: Outcome;
}

/** An earlier comparison's answered rows and the days they span, kept while a restarted one has none of its own. */
export interface EarlierResult {
    readonly from: number;
    readonly to: number;
    /** How many samples each group held, the most any of its rows stood on: what a restarted comparison must match. */
    readonly on: number;
    readonly off: number;
    readonly rows: readonly ResultRow[];
}

export interface ResultTable {
    readonly unit: SampleUnit;
    /** How many samples each group holds. */
    readonly on: number;
    readonly off: number;
    /** Samples each group needs before any row can answer; absent when the experiment publishes no threshold. */
    readonly minimum?: number;
    readonly rows: readonly ResultRow[];
    readonly previous?: EarlierResult;
}

const whole = (value: number): number => Math.round(Math.abs(value));

// `minimum` is the experiment's threshold, which turns an early row into how far along it is.
export const outcomeOf = (reading: TurnMetricReading, minimum?: number): Outcome => {
    if (reading.marginPct === undefined) {
        return minimum === undefined ? { kind: `early` } : { kind: `early`, have: Math.min(reading.on.turns, reading.off.turns), need: minimum };
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

// The readings whose averages are shares of turns rather than counts per turn.
const SHARE_ROWS: ReadonlySet<RowKey> = new Set([`openedWithListing`]);
// The readings whose averages are thousands of tokens, where a tenth means nothing.
const TOKEN_ROWS: ReadonlySet<RowKey> = new Set([`openingPrompt`, `openingWrite`]);

const rowOf = (reading: TurnMetricReading, minimum: number | undefined): ResultRow => ({
    key: reading.metric,
    on: reading.on.mean,
    off: reading.off.mean,
    share: SHARE_ROWS.has(reading.metric),
    tokens: TOKEN_ROWS.has(reading.metric),
    samples: { on: reading.on.turns, off: reading.off.turns },
    outcome: outcomeOf(reading, minimum),
});

// An opening turn is one per conversation, so the reader counts conversations either way.
const unitOf = (experiment: TurnExperiment): SampleUnit => (experiment.sampleUnit === `turns` || experiment.sampleUnit === undefined ? `turns` : `conversations`);

/** Undefined until the daemon has an experiment to report, which the panel says in words. */
export const tableOf = (experiment: TurnExperiment | undefined): ResultTable | undefined => {
    if (experiment === undefined) {
        return undefined;
    }
    // Every reading is over the same coin flip, so the first one's group sizes are the table's; a row that reads only
    // some of those samples carries its own.
    const [first] = experiment.metrics;
    const table: ResultTable = {
        unit: unitOf(experiment),
        on: first.on.turns,
        off: first.off.turns,
        minimum: experiment.minTurns,
        rows: experiment.metrics.map((reading) => rowOf(reading, experiment.minTurns)),
    };
    const { previous } = experiment;
    if (previous === undefined || previous.metrics.length === 0) {
        return table;
    }
    return {
        ...table,
        previous: {
            from: previous.from,
            to: previous.to,
            on: Math.max(...previous.metrics.map((reading) => reading.on.turns)),
            off: Math.max(...previous.metrics.map((reading) => reading.off.turns)),
            rows: previous.metrics.map((reading) => rowOf(reading, undefined)),
        },
    };
};
