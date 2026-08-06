import type { DayWindowQuery, IqContextOutcome, TurnExperiment, TurnMetricReading, UsageTurn } from "@intentic/sandbox-contract";
import type { UsageStore } from "./usage-store.js";

/* THE TURN-LEVEL EXPERIMENTS, read back out of the spend ledger: what the terse steer and the pre-injected
 * workspace context are each worth, measured rather than asserted.
 *
 * A cleaned command carries its own baseline — the raw capture and the emitted result come out of the same
 * event — so the input-side report can be exact. A turn cannot: there is no second run of the same turn to see
 * what it would have cost unsteered, or without the context it opened with. The only honest number therefore
 * comes from a turn-level holdout (settings.terseHoldout, settings.iqContextHoldout), which flips a fraction of
 * eligible turns to the control arm and stamps which arm ran onto the ledger (UsageTurn.terse,
 * UsageTurn.iqContext). This reads those two populations back.
 *
 * BOTH EXPERIMENTS SHARE EVERY LINE OF THE STATISTICS and differ only in which field carries the arm and what
 * the turns are judged on — so the metric is a parameter, not a second copy of Welch. A turn can sit in both at
 * once (the flips are independent), which is exactly why each is read as its own two populations: the other
 * experiment's coin flip is then just noise, distributed evenly across both of these arms.
 *
 * AND EACH EXPERIMENT MAY BE READ SEVERAL WAYS. One coin flip, one arm assignment, one delivery rate — and, for
 * pre-injection, two metrics over them, because the searches a turn ran and the searches it ran before touching
 * a file answer different halves of the same question. They are readings, not experiments: the arms underneath
 * them are the same turns.
 *
 * WHAT THE WITHHELD NUMBER OWED THE READER, and what it cost to learn. Nine days of real use put pre-injection
 * at +27.0% ± 29.9pp on COST — withheld, correctly, because that interval runs from −2.9% to +56.9%. Read
 * against the transcripts the gap turned out not to be the mechanism at all: every raw outcome moved with it
 * (reads +58%, duration +73%, cache-read tokens +28%), and every outcome with turn size divided out was flat to
 * within a point. It was the coin flip handing the treatment arm the bigger jobs. Cost per turn is the price of
 * a whole turn's work; retrieval moves one part of it; so the part lived inside the noise of the rest and no
 * amount of waiting was going to separate them — the same trap output tokens laid for the terse steer. The
 * metrics below are the fix: count the thing the mechanism actually removes.
 *
 * WHY A NUMBER IS WITHHELD, TWICE. Per-turn quantities are wildly heteroscedastic — one turn is "yes", the next
 * is a forty-tool refactor — so a delta over a handful of turns is noise wearing a percentage sign. The first
 * gate is arm size: below MIN_ARM_TURNS the arms are reported without a delta, which the screen shows as
 * "measuring".
 *
 * Clearing it turned out not to be enough. The terse steer reached its thirtieth control turn and published
 * +31.2% ± 35.1pp — an interval from −3.4% to +66.7%, which is no measurement at all — and it published it
 * against the arm that had happened to draw the longer tasks. So the second gate is the margin itself: an
 * interval that spans zero yields its resolution and no claim. Between them the two gates are one rule, that a
 * number reaches the screen when it means something and not when it merely exists. */

// Turns per arm before a delta is reported. Thirty is where the normal approximation behind the margin below
// starts to hold for a distribution this skewed; it is also small enough to be reachable in a day of real use.
export const MIN_ARM_TURNS = 30;

// 95% two-sided normal quantile — the margin is a normal approximation (Welch), which is what MIN_ARM_TURNS
// buys. A t-quantile would differ in the third digit at these sample sizes and needs a table this file would
// otherwise have no reason to carry.
const Z_95 = 1.96;

/* What a mechanism is judged on, and at what precision it is reported.
 *
 * The terse steer is judged on the model's own PROSE, which is the thing it steers. It used to be judged on the
 * turn's output tokens, and that is a different quantity: a real turn's output is 91.6% tool-call arguments,
 * so a fifth off the narration moved the reported number by 1.6% and the measurement was left reporting which
 * arm drew the bigger tasks.
 *
 * Pre-injection is judged on SEARCHES, for exactly that reason — it removes searches, so searches are what can
 * see it. Twice over, because the two readings fail differently and neither alone is enough: `searchCalls` is
 * every search the turn ran, which is the whole of what the mechanism displaces but still grows with the size
 * of the job; `openingSearches` stops at the first file the turn opened or changed, which is the orientation
 * retrieval is actually aimed at and is roughly the same act whatever the job turns out to be. A real effect
 * shows in both. An effect that shows only in the first is the arms drawing different-sized work again.
 *
 * A metric can also be UNMEASURED on a turn (a row written before it was recorded), which is not the same as
 * zero — `of` returns undefined there and the turn leaves the population rather than dragging the mean down. A
 * turn that genuinely searched nothing records a zero and stays: it dilutes both arms alike, where dropping it
 * would filter the population by an outcome the treatment moves.
 *
 * The rounding rides with the metric because a search count put through the character rounder loses the decimal
 * that a mean of three-point-something is entirely made of. */
interface Metric {
    readonly name: TurnMetricReading["metric"];
    readonly of: (turn: UsageTurn) => number | undefined;
    readonly round: (value: number) => number;
}

const round1 = (value: number): number => Math.round(value * 10) / 10;

const PROSE_CHARS: Metric = { name: "proseChars", of: (turn) => turn.proseChars, round: Math.round };
// A tenth of a search, because a mean turn runs a handful and the delta between two arms is a fraction of one.
const SEARCH_CALLS: Metric = { name: "searchCalls", of: (turn) => turn.searchCalls, round: round1 };
const OPENING_SEARCHES: Metric = { name: "openingSearches", of: (turn) => turn.openingSearches, round: round1 };

interface Arm {
    readonly turns: number;
    readonly mean: number;
    // Sample variance (n−1). Zero for a single turn, which the threshold rules out of the reported path anyway.
    readonly variance: number;
}

const armOf = (turns: readonly UsageTurn[], metric: Metric): Arm => {
    // A turn the metric was never recorded on is not a turn worth zero — it is a turn from before the metric
    // existed, and averaging it in would pull both arms toward nothing at whatever rate the ledger happens to
    // hold old rows.
    const values = turns.map(metric.of).filter((value) => value !== undefined);
    if (values.length === 0) {
        return { turns: 0, mean: 0, variance: 0 };
    }
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const variance = values.length < 2 ? 0 : values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
    return { turns: values.length, mean, variance };
};

/* WHAT REACHED THE TREATMENT ARM, and what took away the rest. Both come off the same field, because a rate
 * without its reasons is a number nobody can act on: 81% of an assigned arm delivering nothing reads as a
 * broken mechanism until you can see that most of it is the eligibility gate declining on prompts that named
 * their own file, which is the gate working. Undefined ⇒ no turn in the window recorded an outcome. */
const deliveryOf = (
    turns: readonly UsageTurn[],
): { readonly deliveredPct: number; readonly outcomes: { outcome: IqContextOutcome; turns: number }[] } | undefined => {
    const known = turns.map((turn) => turn.iqContextOutcome).filter((outcome) => outcome !== undefined);
    if (known.length === 0) {
        return undefined;
    }
    const counts = new Map<IqContextOutcome, number>();
    for (const outcome of known) {
        counts.set(outcome, (counts.get(outcome) ?? 0) + 1);
    }
    return {
        deliveredPct: round1(((counts.get("note") ?? 0) / known.length) * 100),
        // Largest first, and sorted HERE so every reader gets the order the contract promises — a screen that
        // re-sorts to find the biggest loss is a screen that can disagree with the ledger about what it was.
        outcomes: [...counts].map(([outcome, count]) => ({ outcome, turns: count })).toSorted((a, b) => b.turns - a.turns),
    };
};

/* The resolution this is aiming AT. A mechanism that moves its own metric by less than a tenth is not one
 * anybody would act on — the turn-to-turn spread of what people ask for swamps it — so ±10pp is where the
 * experiment stops being worth more data. It is a judgement, stated once here rather than left implicit in an
 * estimate that quietly chases whatever the arms happen to show today. */
const RESOLVING_MARGIN_PCT = 10;

/* WHAT IT WOULD TAKE to resolve, in the only currency the reader controls: more control turns.
 *
 * AIMED AT A FIXED RESOLUTION, not at the effect currently on screen. Targeting "enough to clear today's delta"
 * was the first attempt and it reported FOURTEEN more turns against nine days of data that had never once
 * resolved — because the observed delta is mostly noise, and an estimate divided by noise inherits it, promising
 * an answer next Tuesday for as long as the noise happens to be large. Against a fixed ±10pp the same ledger
 * asks for a few hundred, which is the true shape of the thing: this holdout is not close.
 *
 * The margin falls with the square root of the smaller arm, so the control arm scales by (margin ÷ target)².
 * Only that arm is scaled, though the treatment arm grows alongside it — which makes this an OVERestimate, and
 * an order-of-magnitude figure either way. It is read to tell "a few more days" from "not at this holdout", and
 * it is honest at that resolution and no finer. */
const controlTurnsNeededFor = (offTurns: number, marginPct: number): number | undefined => {
    if (marginPct <= RESOLVING_MARGIN_PCT) {
        return undefined;
    }
    return Math.ceil(offTurns * (marginPct / RESOLVING_MARGIN_PCT) ** 2) - offTurns;
};

// One metric over one experiment's two populations. The arms arrive already split, because every reading of an
// experiment reads the SAME split — the coin flip happened once, and only the counting differs.
const readingOf = (onTurns: readonly UsageTurn[], offTurns: readonly UsageTurn[], metric: Metric): TurnMetricReading => {
    const on = armOf(onTurns, metric);
    const off = armOf(offTurns, metric);
    const arms = {
        metric: metric.name,
        on: { turns: on.turns, mean: metric.round(on.mean) },
        off: { turns: off.turns, mean: metric.round(off.mean) },
    };
    if (on.turns < MIN_ARM_TURNS || off.turns < MIN_ARM_TURNS || off.mean === 0) {
        return arms;
    }

    // Welch: the arms have different sizes (the holdout is a minority by design) and different spreads, so the
    // pooled-variance form would understate the margin exactly where the control is smallest.
    const standardError = Math.sqrt(on.variance / on.turns + off.variance / off.turns);
    const deltaPct = round1(((on.mean - off.mean) / off.mean) * 100);
    const marginPct = round1(((Z_95 * standardError) / off.mean) * 100);
    /* THE INTERVAL SPANS ZERO, so there is no effect to report — only a resolution. Clearing MIN_ARM_TURNS
     * proves the normal approximation holds, not that it has resolved anything: the terse steer crossed its
     * thirtieth control turn and published +31.2% ± 35.1pp, an interval from −3.4% to +66.7%. Publishing the
     * midpoint of that is publishing noise with a sign on it, and a reader acts on the sign.
     *
     * The margin still goes out. "Whatever this is worth, it is inside ±35 points" is the honest reading, and
     * it is the one that says to keep collecting rather than to go and change something. */
    if (Math.abs(deltaPct) <= marginPct) {
        const controlTurnsNeeded = controlTurnsNeededFor(off.turns, marginPct);
        return { ...arms, marginPct, ...(controlTurnsNeeded !== undefined ? { controlTurnsNeeded } : {}) };
    }
    return {
        ...arms,
        marginPct,
        deltaPct,
        // What the mechanism was worth over the turns that actually ran with it — the window's realized saving,
        // not an extrapolation over turns it never touched.
        saved: metric.round((off.mean - on.mean) * on.turns),
    };
};

// Undefined ⇒ this experiment isn't running: no turn in the window recorded an arm for it, so there is nothing
// to report. That is a different state from "measured, saved nothing", and the screen renders it as absence.
const experimentOf = (
    turns: readonly UsageTurn[],
    arm: (turn: UsageTurn) => boolean | undefined,
    // Headline first — the screens take the head for the big number and the tail as the lines under it, which
    // is why the tuple shape travels all the way from here to the contract rather than being an array anyone
    // downstream has to check for emptiness.
    metrics: readonly [Metric, ...Metric[]],
    // Delivery is asked of pre-injection alone: its arm is the coin flip, and a turn can be assigned the
    // retrieval and still have nothing to prepend. The steer, once assigned, always lands.
    asksDelivery = false,
): TurnExperiment | undefined => {
    // Only turns the experiment applied to. A turn with no arm stamped had the mechanism out of play entirely
    // (a custom system prompt drops the steer, an ineligible prompt is never retrieved for, and so does the
    // experiment being off) — pooling those into the off-arm would compare the treated turns against a
    // population selected by something other than the coin flip.
    const on = turns.filter((turn) => arm(turn) === true);
    const off = turns.filter((turn) => arm(turn) === false);
    if (on.length === 0 && off.length === 0) {
        return undefined;
    }
    const delivery = asksDelivery ? deliveryOf(on) : undefined;
    const [headline, ...rest] = metrics;
    return {
        metrics: [readingOf(on, off, headline), ...rest.map((metric) => readingOf(on, off, metric))],
        minTurns: MIN_ARM_TURNS,
        ...(delivery !== undefined ? { deliveredPct: delivery.deliveredPct, outcomes: delivery.outcomes } : {}),
    };
};

// One read of the ledger serves both experiments; each is then its own pair of populations over those turns.
export const readTurnExperiments = async (
    usage: UsageStore,
    window: DayWindowQuery,
): Promise<{ readonly output?: TurnExperiment; readonly context?: TurnExperiment }> => {
    const turns = await usage.turns(window);
    const output = experimentOf(turns, (turn) => turn.terse, [PROSE_CHARS]);
    const context = experimentOf(turns, (turn) => turn.iqContext, [SEARCH_CALLS, OPENING_SEARCHES], true);
    return { ...(output !== undefined ? { output } : {}), ...(context !== undefined ? { context } : {}) };
};
