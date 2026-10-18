// Measures the context mechanisms (the search teaching, the project map, the field notes) off rows of
// turns rather than asserting their value: each mechanism holds a share of conversations out as a control, and this
// compares the two arms. The teaching applies every turn, so a conversation's sample averages over its turns; the map
// applies once, so its sample is the opening turn alone. A delta is shown only once both arms reach MIN_ARM_TURNS and the
// margin excludes zero; otherwise the reading reports arm sizes with no claim. The sandbox daemon reads its usage ledger
// through this and the Claude Code plugin its session transcripts, so the two reports are one arithmetic.

// Turns per arm before a delta is reported; where the normal approximation behind the margin starts to hold.
export const MIN_ARM_TURNS = 30;

// 95% two-sided normal quantile (Welch); a t-quantile would differ only in the third digit at this sample size.
const Z_95 = 1.96;

// What a turn is judged on, as the savings contract spells each reading:
// searchCalls: searches a turn ran (the search teaching).
// openingSearches: same, narrowed to before the turn first touched a file.
// openedWithListing: whether a turn listed directories to orient itself, as a share of turns (the project map).
// callsBeforeTarget: how far a turn walked before touching a file it went on to edit.
// failedCalls: tool calls that ended in error (the field notes, whose largest section is a failure taxonomy).
// openingPrompt: tokens the turn's first request sent, which every later call of the turn reads again (tool search).
// openingWrite: tokens a follow-up turn's first request wrote to the cache rather than read from it (the stable prompt).
export type MetricName =
    | "searchCalls"
    | "openingSearches"
    | "openedWithListing"
    | "callsBeforeTarget"
    | "failedCalls"
    | "openingPrompt"
    | "openingWrite";

// The readings whose arm mean is a share of turns, 0 to 1, rather than a count per turn; said as a percentage.
export const isShareMetric = (metric: MetricName): boolean => metric === "openedWithListing";

// One turn as the arithmetic reads it: which conversation it belongs to, when and where in it it ran, and its readings.
// Absent readings are unmeasured, never zero.
export interface MeasuredTurn {
    readonly conversationId?: string | undefined;
    readonly at: number;
    readonly turnIndex?: number | undefined;
    readonly searchCalls?: number | undefined;
    readonly openingSearches?: number | undefined;
    readonly openingListings?: number | undefined;
    readonly callsBeforeTarget?: number | undefined;
    readonly failedCalls?: number | undefined;
    // The first request's cache reads and writes; absent where the runtime reports no per-request usage.
    readonly openingCacheReadTokens?: number | undefined;
    readonly openingCacheCreationTokens?: number | undefined;
}

export type SampleUnit = "turns" | "conversations" | "opening turns";

// One arm of an experiment; mean is per turn, since the two arms never hold the same count, and taken over samples
// capped at the pooled 95th percentile (CAP_QUANTILE). For a yes/no reading the mean is the share of yeses.
export interface ArmReading {
    readonly turns: number;
    readonly mean: number;
}

export interface TurnMetricReading {
    readonly metric: MetricName;
    readonly on: ArmReading;
    readonly off: ArmReading;
    // Additional control turns to reach a fixed target resolution; absent means nothing to wait for.
    readonly controlTurnsNeeded?: number;
    // ± percentage points at 95% (Welch), once both arms clear MIN_ARM_TURNS.
    readonly marginPct?: number;
    // Change in the metric's mean per turn, only once the margin excludes zero; negative is a saving.
    readonly deltaPct?: number;
    // What that delta was worth over the turns that ran with it, in the metric's own unit.
    readonly saved?: number;
}

// An earlier comparison's answers, kept beside a restarted one so a finding does not vanish from the screen the day the
// treatment or the measurement changes. Only the readings that reached an answer: a margin, with or without a delta.
export interface EarlierExperiment {
    // Its first and last measured turn inside the window read, epoch ms.
    readonly from: number;
    readonly to: number;
    readonly cohort?: string;
    readonly metrics: TurnMetricReading[];
}

export interface TurnExperiment {
    // A head and a tail, so "always a headline" is a type fact rather than a check every reader repeats.
    readonly metrics: [TurnMetricReading, ...TurnMetricReading[]];
    readonly minTurns: number;
    readonly sampleUnit?: SampleUnit;
    // The treatment's revision the reading covers; the latest one, so two revisions never blur into one experiment.
    readonly cohort?: string;
    // The latest earlier cohort that reached an answer; absent when none did.
    readonly previous?: EarlierExperiment;
}

interface Metric {
    readonly name: MetricName;
    readonly of: (turn: MeasuredTurn) => number | undefined;
    readonly round: (value: number) => number;
    // A yes/no reading has no tail to cut, and capping it at the pooled 95th percentile would turn every yes into a no
    // whenever fewer than one turn in twenty says yes.
    readonly uncapped?: true;
}

const round1 = (value: number): number => Math.round(value * 10) / 10;
// A share to a tenth of a percent.
const round3 = (value: number): number => Math.round(value * 1000) / 1000;

// Rounded to a tenth: an arm delta is a fraction of one call.
const SEARCH_CALLS: Metric = { name: "searchCalls", of: (turn) => turn.searchCalls, round: round1 };
const OPENING_SEARCHES: Metric = { name: "openingSearches", of: (turn) => turn.openingSearches, round: round1 };
// The map's two readings: what it stops the turn doing, and whether it got there sooner. The first as a share of opening
// turns that listed at all, not a mean count: most list nothing and a few list three times, so the count's mean read
// "0.4 against 0.3", a figure nobody counts in, where the share reads "27% of first turns against 22%".
const OPENED_WITH_LISTING: Metric = {
    name: "openedWithListing",
    of: (turn) => (turn.openingListings === undefined ? undefined : Number(turn.openingListings > 0)),
    round: round3,
    uncapped: true,
};
const CALLS_BEFORE_TARGET: Metric = { name: "callsBeforeTarget", of: (turn) => turn.callsBeforeTarget, round: round1 };
// The field notes' headline: the brief's largest section is a taxonomy of what fails, so calls that ended in error is
// the reading it either moves or does not.
const FAILED_CALLS: Metric = { name: "failedCalls", of: (turn) => turn.failedCalls, round: round1 };
// Tool search's headline: what it takes out of the prompt is what every call of the turn stops re-reading. Both halves
// or neither: a turn that reports only one of them measured half a request.
const OPENING_PROMPT: Metric = {
    name: "openingPrompt",
    of: (turn) =>
        turn.openingCacheReadTokens === undefined || turn.openingCacheCreationTokens === undefined
            ? undefined
            : turn.openingCacheReadTokens + turn.openingCacheCreationTokens,
    round: Math.round,
};
// The stable prompt's headline: a follow-up whose prefix still matched reads it back, one whose prefix moved writes all
// of it again. Opening turns are left out, since they write their whole prompt whatever either arm does.
const OPENING_WRITE: Metric = {
    name: "openingWrite",
    of: (turn) => (turn.turnIndex === undefined || turn.turnIndex === 0 ? undefined : turn.openingCacheCreationTokens),
    round: Math.round,
};

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

// Every conversation is counted, but none above the pooled 95th percentile: one runaway conversation otherwise moves a
// mean by half (identical arms read 42 vs 28 on this ledger), and with labels shuffled the uncapped comparison called
// 8-11% of no-effect splits significant against its nominal 5%, the capped one 4-6%.
const CAP_QUANTILE = 0.95;

const capped = (on: readonly number[], off: readonly number[]): { readonly on: number[]; readonly off: number[] } => {
    const pooled = [...on, ...off].toSorted((left, right) => left - right);
    const cap = pooled[Math.min(pooled.length - 1, Math.floor(CAP_QUANTILE * pooled.length))] ?? 0;
    const bound = (values: readonly number[]): number[] => values.map((value) => Math.min(value, cap));
    return { on: bound(on), off: bound(off) };
};

const RESOLVING_MARGIN_PCT = 10;

const controlTurnsNeededFor = (offTurns: number, marginPct: number): number | undefined => {
    if (marginPct <= RESOLVING_MARGIN_PCT) {
        return undefined;
    }
    return Math.ceil(offTurns * (marginPct / RESOLVING_MARGIN_PCT) ** 2) - offTurns;
};

const readingOfArms = (on: Arm, off: Arm, metric: Metric, claimRealizedSaving: boolean): TurnMetricReading => {
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

// What a mechanism is judged on and how a conversation becomes one sample; a new mechanism is a new record here, not a
// copy of the arithmetic.
export interface Mechanism {
    readonly metrics: readonly [Metric, ...Metric[]];
    readonly sampleUnit: SampleUnit;
    // A conversation's contribution from its surviving turns; undefined means no signal, not zero.
    readonly sample: (turns: readonly MeasuredTurn[], metric: Metric) => number | undefined;
}

// Average over a conversation's turns, for a treatment that acts on every one of them.
const meanOfTurns = (turns: readonly MeasuredTurn[], metric: Metric): number | undefined => {
    const measured = turns.map(metric.of).filter((value) => value !== undefined);
    return measured.length === 0 ? undefined : measured.reduce((sum, value) => sum + value, 0) / measured.length;
};

// The conversation's opening turn, for a treatment sent once and never again. Uses `turnIndex === 0`, not the earliest
// row in the window, since a window can start mid-conversation; a row with no `turnIndex` is skipped, not guessed at.
const openingTurn = (turns: readonly MeasuredTurn[], metric: Metric): number | undefined => {
    const opening = turns.filter((turn) => turn.turnIndex === 0).toSorted((left, right) => left.at - right.at)[0];
    return opening === undefined ? undefined : metric.of(opening);
};

export const MECHANISMS = {
    // The search teaching rides every turn, so every turn is evidence.
    search: { metrics: [SEARCH_CALLS, OPENING_SEARCHES], sampleUnit: "conversations", sample: meanOfTurns },
    // The map is sent once and judged on the turn it was sent to; `callsBeforeTarget` exists only on turns that edited.
    map: { metrics: [OPENED_WITH_LISTING, CALLS_BEFORE_TARGET], sampleUnit: "opening turns", sample: openingTurn },
    // The brief rides the whole session, so turn 40 is as much evidence as turn 1.
    notes: { metrics: [FAILED_CALLS, CALLS_BEFORE_TARGET], sampleUnit: "conversations", sample: meanOfTurns },
    // Deferred schemas leave every request of the session, so every turn is evidence; failed calls are the price it
    // could charge, a model reaching for a tool it has not looked up yet.
    toolSearch: { metrics: [OPENING_PROMPT, FAILED_CALLS], sampleUnit: "conversations", sample: meanOfTurns },
    // What moved between turns is said on the message, so the system block stops rewriting the cache; failed calls are
    // the price it could charge, a turn that did not take a note as seriously as an instruction.
    stablePrompt: { metrics: [OPENING_WRITE, FAILED_CALLS], sampleUnit: "conversations", sample: meanOfTurns },
    coldTrim: { metrics: [OPENING_PROMPT, FAILED_CALLS], sampleUnit: "conversations", sample: meanOfTurns },
} as const satisfies Record<string, Mechanism>;

// One experiment: a mechanism, plus where a row says which arm it ran and which revision of the treatment it saw.
export interface Design<Row extends MeasuredTurn> extends Mechanism {
    readonly arm: (turn: Row) => boolean | undefined;
    // The treatment's revision; undefined for a mechanism with no revisions to mix (the map is recomputed every send).
    readonly cohort: (turn: Row) => string | undefined;
    // Whether an earlier cohort compared the same two things, so its answers can stand in for the current one's while
    // that is still early; absent means every cohort did.
    readonly comparable?: (cohort: string | undefined) => boolean;
}

interface ConversationSample<Row> {
    readonly arm: boolean;
    readonly turns: readonly Row[];
}

// One cohort's readings, from its conversations: undefined when none of them carries an arm.
const readCohort = <Row extends MeasuredTurn>(cohortTurns: readonly Row[], design: Design<Row>): [TurnMetricReading, ...TurnMetricReading[]] | undefined => {
    const grouped = new Map<string, { arm: boolean; valid: boolean; turns: Row[] }>();
    for (const turn of cohortTurns) {
        const arm = design.arm(turn);
        if (turn.conversationId === undefined || arm === undefined) {
            continue;
        }
        const current = grouped.get(turn.conversationId);
        if (current === undefined) {
            grouped.set(turn.conversationId, { arm, valid: true, turns: [turn] });
        } else {
            // A conversation that reports both arms was re-drawn mid-way and belongs to neither.
            current.valid &&= current.arm === arm;
            current.turns.push(turn);
        }
    }
    const samples: ConversationSample<Row>[] = [...grouped.values()]
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
        const arms = metric.uncapped === true ? { on: values(true), off: values(false) } : capped(values(true), values(false));
        return readingOfArms(armOfValues(arms.on), armOfValues(arms.off), metric, false);
    };
    const [headline, ...rest] = design.metrics;
    return [reading(headline), ...rest.map(reading)];
};

const answered = (reading: TurnMetricReading): boolean => reading.marginPct !== undefined;

// Earlier cohorts newest first by their last measured turn; the first one with an answered reading, unless the design
// says it compared something else.
const previousOf = <Row extends MeasuredTurn>(turns: readonly Row[], design: Design<Row>, current: string | undefined): EarlierExperiment | undefined => {
    const spans = new Map<string | undefined, { from: number; to: number }>();
    for (const turn of turns) {
        const cohort = design.cohort(turn);
        if (design.arm(turn) === undefined || cohort === current || design.comparable?.(cohort) === false) {
            continue;
        }
        const span = spans.get(cohort);
        spans.set(cohort, { from: Math.min(span?.from ?? turn.at, turn.at), to: Math.max(span?.to ?? turn.at, turn.at) });
    }
    for (const [cohort, span] of [...spans].toSorted((left, right) => right[1].to - left[1].to)) {
        const metrics = readCohort(
            turns.filter((turn) => design.cohort(turn) === cohort),
            design,
        )?.filter(answered);
        if (metrics !== undefined && metrics.length > 0) {
            return cohort === undefined ? { ...span, metrics } : { ...span, cohort, metrics };
        }
    }
    return undefined;
};

// Undefined when no conversation carries an arm at all, which readers show as "not measured", never as zero.
export const measureExperiment = <Row extends MeasuredTurn>(turns: readonly Row[], design: Design<Row>): TurnExperiment | undefined => {
    const latest = turns
        .filter((turn) => design.arm(turn) !== undefined && design.cohort(turn) !== undefined)
        .toSorted((left, right) => right.at - left.at)[0];
    const cohort = latest === undefined ? undefined : design.cohort(latest);
    const metrics = readCohort(
        turns.filter((turn) => design.cohort(turn) === cohort),
        design,
    );
    if (metrics === undefined) {
        return undefined;
    }
    let experiment: TurnExperiment = { metrics, minTurns: MIN_ARM_TURNS, sampleUnit: design.sampleUnit };
    if (cohort !== undefined) {
        experiment = { ...experiment, cohort };
    }
    const previous = previousOf(turns, design, cohort);
    if (previous !== undefined) {
        experiment = { ...experiment, previous };
    }
    return experiment;
};
