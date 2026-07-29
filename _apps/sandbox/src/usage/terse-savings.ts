import type { DayWindowQuery, OutputSavings, UsageTurn } from "@intentic/sandbox-contract";
import type { UsageStore } from "./usage-store.js";

/* The output-side savings report: what the terse steer is worth, measured rather than asserted.
 *
 * A cleaned command carries its own baseline — the raw capture and the emitted result come out of the same
 * event — so the input-side report can be exact. A turn cannot: there is no second run of the same turn to see
 * what it would have said unsteered. The only honest number therefore comes from the turn-level holdout
 * (settings.terseHoldout), which flips a fraction of eligible turns to the unsteered arm and stamps which arm
 * ran onto the spend ledger (UsageTurn.terse). This reads those two populations back.
 *
 * WHY THE NUMBER IS WITHHELD UNTIL BOTH ARMS ARE BIG. Output tokens per turn are wildly heteroscedastic — one
 * turn is "yes", the next is a forty-tool refactor — so a delta over a handful of turns is noise wearing a
 * percentage sign. Below the threshold the arms are reported without a delta, which the screen shows as
 * "measuring", and a number that would swing from −34% to −8% overnight never reaches anyone. */

// Turns per arm before a delta is reported. Thirty is where the normal approximation behind the margin below
// starts to hold for a distribution this skewed; it is also small enough to be reachable in a day of real use.
export const MIN_ARM_TURNS = 30;

// 95% two-sided normal quantile — the margin is a normal approximation (Welch), which is what MIN_ARM_TURNS
// buys. A t-quantile would differ in the third digit at these sample sizes and needs a table this file would
// otherwise have no reason to carry.
const Z_95 = 1.96;

interface Arm {
    readonly turns: number;
    readonly mean: number;
    // Sample variance (n−1). Zero for a single turn, which the threshold rules out of the reported path anyway.
    readonly variance: number;
}

const armOf = (turns: readonly UsageTurn[]): Arm => {
    if (turns.length === 0) {
        return { turns: 0, mean: 0, variance: 0 };
    }
    const values = turns.map((turn) => turn.outputTokens);
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const variance = values.length < 2 ? 0 : values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
    return { turns: values.length, mean, variance };
};

const round = (value: number): number => Math.round(value * 10) / 10;

// Undefined ⇒ the experiment isn't running: no turn in the window recorded an arm, so there is nothing to
// report. That is a different state from "measured, saved nothing", and the screen renders it as absence.
export const readOutputSavings = async (usage: UsageStore, window: DayWindowQuery): Promise<OutputSavings | undefined> => {
    const turns = await usage.turns(window);
    // Only turns the experiment applied to. A turn with no arm stamped had the steer out of play entirely (a
    // custom system prompt drops it, and so does the experiment being off) — pooling those into the off-arm
    // would compare the steered turns against a population selected by something other than the coin flip.
    const on = armOf(turns.filter((turn) => turn.terse === true));
    const off = armOf(turns.filter((turn) => turn.terse === false));
    if (on.turns === 0 && off.turns === 0) {
        return undefined;
    }

    const arms = {
        on: { turns: on.turns, meanOutputTokens: Math.round(on.mean) },
        off: { turns: off.turns, meanOutputTokens: Math.round(off.mean) },
        minTurns: MIN_ARM_TURNS,
    };
    if (on.turns < MIN_ARM_TURNS || off.turns < MIN_ARM_TURNS || off.mean === 0) {
        return arms;
    }

    // Welch: the arms have different sizes (the holdout is a minority by design) and different spreads, so the
    // pooled-variance form would understate the margin exactly where the control is smallest.
    const standardError = Math.sqrt(on.variance / on.turns + off.variance / off.turns);
    return {
        ...arms,
        deltaPct: round(((on.mean - off.mean) / off.mean) * 100),
        marginPct: round(((Z_95 * standardError) / off.mean) * 100),
        // What the steer was worth over the turns that actually ran with it — the window's realized saving,
        // not an extrapolation over turns that were never steered.
        savedTokens: Math.round((off.mean - on.mean) * on.turns),
    };
};
