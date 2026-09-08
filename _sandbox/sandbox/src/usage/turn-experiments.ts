import type { DayWindowQuery, TurnExperiment, TurnMetricReading, UsageTurn } from "@intentic/sandbox-contract";
import type { UsageStore } from "./usage-store.js";

// Measures the mechanism experiments (iq search teaching, project map) off the ledger rather than asserting their
// value. The teaching applies every turn, so a conversation's sample averages over turns; the map applies once, so its
// sample is the opening turn alone. A delta is shown only once both arms reach MIN_ARM_TURNS and the margin excludes
// zero; otherwise the reading reports arm sizes with no claim.

// Turns per arm before a delta is reported; where the normal approximation behind the margin starts to hold.
export const MIN_ARM_TURNS = 30;

// 95% two-sided normal quantile (Welch); a t-quantile would differ only in the third digit at this sample size.
const Z_95 = 1.96;

interface Metric {
    readonly name: TurnMetricReading["metric"];
    readonly of: (turn: UsageTurn) => number | undefined;
    readonly round: (value: number) => number;
}

const round1 = (value: number): number => Math.round(value * 10) / 10;

// Rounds to a tenth of a search; the arm delta is a fraction of one full search.
const SEARCH_CALLS: Metric = { name: "searchCalls", of: (turn) => turn.searchCalls, round: round1 };
const OPENING_SEARCHES: Metric = { name: "openingSearches", of: (turn) => turn.openingSearches, round: round1 };
// The map's two readings: what it stops the turn doing, and whether it got there sooner.
const ROOT_LISTINGS: Metric = { name: "openingListings", of: (turn) => turn.openingListings, round: round1 };
const CALLS_BEFORE_TARGET: Metric = { name: "callsBeforeTarget", of: (turn) => turn.callsBeforeTarget, round: round1 };

interface Arm {
    readonly turns: number;
    readonly mean: number;
    // Sample variance (n−1); zero for a single turn.
    readonly variance: number;
}

const armOfValues = (values: readonly number[]): Arm => {
    if (values.length === 0) {
        return { turns: 0, mean: 0, variance: 0 };
    }
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const variance = values.length < 2 ? 0 : values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
    return { turns: values.length, mean, variance };
};

const RESOLVING_MARGIN_PCT = 10;

const controlTurnsNeededFor = (offTurns: number, marginPct: number): number | undefined => {
    if (marginPct <= RESOLVING_MARGIN_PCT) {
        return undefined;
    }
    return Math.ceil(offTurns * (marginPct / RESOLVING_MARGIN_PCT) ** 2) - offTurns;
};

const readingOfArms = (on: Arm, off: Arm, metric: Metric, claimRealizedSaving = true): TurnMetricReading => {
    const arms = {
        metric: metric.name,
        on: { turns: on.turns, mean: metric.round(on.mean) },
        off: { turns: off.turns, mean: metric.round(off.mean) },
    };
    if (on.turns < MIN_ARM_TURNS || off.turns < MIN_ARM_TURNS || off.mean === 0) {
        return arms;
    }

    const standardError = Math.sqrt(on.variance / on.turns + off.variance / off.turns);
    const deltaPct = round1(((on.mean - off.mean) / off.mean) * 100);
    const marginPct = round1(((Z_95 * standardError) / off.mean) * 100);
    if (Math.abs(deltaPct) <= marginPct) {
        const controlTurnsNeeded = controlTurnsNeededFor(off.turns, marginPct);
        return { ...arms, marginPct, ...(controlTurnsNeeded !== undefined ? { controlTurnsNeeded } : {}) };
    }
    return {
        ...arms,
        marginPct,
        deltaPct,
        ...(claimRealizedSaving ? { saved: metric.round((off.mean - on.mean) * on.turns) } : {}),
    };
};

interface ConversationSample {
    readonly arm: boolean;
    readonly turns: readonly UsageTurn[];
}

// One experiment's shape: which arm and treatment revision a row ran, what it is judged on, and which turns are its
// sample; a third mechanism becomes a new record here, not a copy of this arithmetic.
interface Design {
    readonly arm: (turn: UsageTurn) => boolean | undefined;
    // The treatment's revision; undefined for a mechanism with no revisions to mix.
    readonly cohort: (turn: UsageTurn) => string | undefined;
    readonly metrics: readonly [Metric, ...Metric[]];
    readonly sampleUnit: NonNullable<TurnExperiment["sampleUnit"]>;
    // A conversation's contribution from its surviving turns; undefined means no signal, not zero.
    readonly sample: (turns: readonly UsageTurn[], metric: Metric) => number | undefined;
}

// Average over a conversation's turns, for a treatment that acts on every one of them.
const meanOfTurns = (turns: readonly UsageTurn[], metric: Metric): number | undefined => {
    const measured = turns.map(metric.of).filter((value) => value !== undefined);
    return measured.length === 0 ? undefined : measured.reduce((sum, value) => sum + value, 0) / measured.length;
};

// The conversation's opening turn, for a treatment sent once and never again. Uses `turnIndex === 0`, not the earliest
// row in the window, since a window can start mid-conversation; a row with no `turnIndex` is skipped, not guessed at.
const openingTurn = (turns: readonly UsageTurn[], metric: Metric): number | undefined => {
    const opening = turns.filter((turn) => turn.turnIndex === 0).toSorted((left, right) => left.at - right.at)[0];
    return opening === undefined ? undefined : metric.of(opening);
};

const experimentOf = (turns: readonly UsageTurn[], design: Design): TurnExperiment | undefined => {
    const latest = turns
        .filter((turn) => design.arm(turn) !== undefined && design.cohort(turn) !== undefined)
        .toSorted((left, right) => right.at - left.at)[0];
    const cohort = latest === undefined ? undefined : design.cohort(latest);
    const cohortTurns =
        cohort === undefined ? turns.filter((turn) => design.cohort(turn) === undefined) : turns.filter((turn) => design.cohort(turn) === cohort);
    const grouped = new Map<string, { arm: boolean; valid: boolean; turns: UsageTurn[] }>();
    for (const turn of cohortTurns) {
        const arm = design.arm(turn);
        if (turn.conversationId === undefined || arm === undefined) {
            continue;
        }
        const current = grouped.get(turn.conversationId);
        if (current === undefined) {
            grouped.set(turn.conversationId, { arm, valid: true, turns: [turn] });
        } else {
            current.valid &&= current.arm === arm;
            current.turns.push(turn);
        }
    }
    const samples: ConversationSample[] = [...grouped.values()]
        .filter((entry) => entry.valid)
        .map((entry) => ({ arm: entry.arm, turns: entry.turns }));
    if (samples.length === 0) {
        return undefined;
    }
    const reading = (metric: Metric): TurnMetricReading => {
        const values = (arm: boolean): number[] =>
            samples.flatMap((sample) => {
                const value = sample.arm === arm ? design.sample(sample.turns, metric) : undefined;
                return value === undefined ? [] : [value];
            });
        return readingOfArms(armOfValues(values(true)), armOfValues(values(false)), metric, false);
    };
    const [headline, ...rest] = design.metrics;
    return {
        metrics: [reading(headline), ...rest.map(reading)],
        minTurns: MIN_ARM_TURNS,
        sampleUnit: design.sampleUnit,
        ...(cohort !== undefined ? { cohort } : {}),
    };
};

const measurable = (turn: UsageTurn): boolean => turn.outcome !== "error" && turn.outcome !== "cancelled";

// The map's headline metric is `openingListings`; `callsBeforeTarget` is secondary and exists only on turns that edited
// something.
const SEARCH_DESIGN: Design = {
    arm: (turn) => turn.iqSearchArm,
    cohort: (turn) => turn.iqSearchCohort,
    metrics: [SEARCH_CALLS, OPENING_SEARCHES],
    sampleUnit: "conversations",
    sample: meanOfTurns,
};

const MAP_DESIGN: Design = {
    arm: (turn) => turn.mapArm,
    // The map has no revisions to cohort by: it is recomputed from the filesystem on every send.
    cohort: () => undefined,
    metrics: [ROOT_LISTINGS, CALLS_BEFORE_TARGET],
    sampleUnit: "opening turns",
    sample: openingTurn,
};

export const readTurnExperiments = async (
    usage: UsageStore,
    window: DayWindowQuery,
): Promise<{ readonly search?: TurnExperiment; readonly map?: TurnExperiment }> => {
    const turns = (await usage.turns(window)).filter(measurable);
    const search = experimentOf(turns, SEARCH_DESIGN);
    const map = experimentOf(turns, MAP_DESIGN);
    return { ...(search !== undefined ? { search } : {}), ...(map !== undefined ? { map } : {}) };
};
