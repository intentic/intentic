import type { DayWindowQuery, TurnExperiment, UsageTurn } from "@intentic/sandbox-contract";
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
 * WHY THE NUMBER IS WITHHELD UNTIL BOTH ARMS ARE BIG. Per-turn cost and output length are wildly
 * heteroscedastic — one turn is "yes", the next is a forty-tool refactor — so a delta over a handful of turns
 * is noise wearing a percentage sign. Below the threshold the arms are reported without a delta, which the
 * screen shows as "measuring", and a number that would swing from −34% to −8% overnight never reaches anyone. */

// Turns per arm before a delta is reported. Thirty is where the normal approximation behind the margin below
// starts to hold for a distribution this skewed; it is also small enough to be reachable in a day of real use.
export const MIN_ARM_TURNS = 30;

// 95% two-sided normal quantile — the margin is a normal approximation (Welch), which is what MIN_ARM_TURNS
// buys. A t-quantile would differ in the third digit at these sample sizes and needs a table this file would
// otherwise have no reason to carry.
const Z_95 = 1.96;

/* What a mechanism is judged on, and at what precision it is reported.
 *
 * The terse steer is judged on the model's OWN output tokens, which is the thing it steers. Pre-injection is
 * judged on cost: it spends input tokens on purpose to buy back the search turns the model would otherwise
 * have paid for, so an output-token verdict would score the buying without the spending and an input-token one
 * the reverse. Money is the only unit the trade nets out in.
 *
 * The rounding rides with the metric because a dollar figure put through the token rounder is zero. */
interface Metric {
    readonly name: TurnExperiment["metric"];
    readonly of: (turn: UsageTurn) => number;
    readonly round: (value: number) => number;
}

const OUTPUT_TOKENS: Metric = { name: "outputTokens", of: (turn) => turn.outputTokens, round: Math.round };
// Sub-cent, because a mean turn costs cents and a per-turn delta is a fraction of one.
const COST_USD: Metric = { name: "costUsd", of: (turn) => turn.costUsd, round: (value) => Math.round(value * 10_000) / 10_000 };

interface Arm {
    readonly turns: number;
    readonly mean: number;
    // Sample variance (n−1). Zero for a single turn, which the threshold rules out of the reported path anyway.
    readonly variance: number;
}

const armOf = (turns: readonly UsageTurn[], metric: Metric): Arm => {
    if (turns.length === 0) {
        return { turns: 0, mean: 0, variance: 0 };
    }
    const values = turns.map(metric.of);
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const variance = values.length < 2 ? 0 : values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
    return { turns: values.length, mean, variance };
};

const round1 = (value: number): number => Math.round(value * 10) / 10;

// Undefined ⇒ this experiment isn't running: no turn in the window recorded an arm for it, so there is nothing
// to report. That is a different state from "measured, saved nothing", and the screen renders it as absence.
const experimentOf = (turns: readonly UsageTurn[], arm: (turn: UsageTurn) => boolean | undefined, metric: Metric): TurnExperiment | undefined => {
    // Only turns the experiment applied to. A turn with no arm stamped had the mechanism out of play entirely
    // (a custom system prompt drops the steer, an ineligible prompt is never retrieved for, and so does the
    // experiment being off) — pooling those into the off-arm would compare the treated turns against a
    // population selected by something other than the coin flip.
    const on = armOf(
        turns.filter((turn) => arm(turn) === true),
        metric,
    );
    const off = armOf(
        turns.filter((turn) => arm(turn) === false),
        metric,
    );
    if (on.turns === 0 && off.turns === 0) {
        return undefined;
    }

    const arms = {
        metric: metric.name,
        on: { turns: on.turns, mean: metric.round(on.mean) },
        off: { turns: off.turns, mean: metric.round(off.mean) },
        minTurns: MIN_ARM_TURNS,
    } as const;
    if (on.turns < MIN_ARM_TURNS || off.turns < MIN_ARM_TURNS || off.mean === 0) {
        return arms;
    }

    // Welch: the arms have different sizes (the holdout is a minority by design) and different spreads, so the
    // pooled-variance form would understate the margin exactly where the control is smallest.
    const standardError = Math.sqrt(on.variance / on.turns + off.variance / off.turns);
    return {
        ...arms,
        deltaPct: round1(((on.mean - off.mean) / off.mean) * 100),
        marginPct: round1(((Z_95 * standardError) / off.mean) * 100),
        // What the mechanism was worth over the turns that actually ran with it — the window's realized saving,
        // not an extrapolation over turns it never touched.
        saved: metric.round((off.mean - on.mean) * on.turns),
    };
};

// One read of the ledger serves both experiments; each is then its own pair of populations over those turns.
export const readTurnExperiments = async (
    usage: UsageStore,
    window: DayWindowQuery,
): Promise<{ readonly output?: TurnExperiment; readonly context?: TurnExperiment }> => {
    const turns = await usage.turns(window);
    const output = experimentOf(turns, (turn) => turn.terse, OUTPUT_TOKENS);
    const context = experimentOf(turns, (turn) => turn.iqContext, COST_USD);
    return { ...(output !== undefined ? { output } : {}), ...(context !== undefined ? { context } : {}) };
};
