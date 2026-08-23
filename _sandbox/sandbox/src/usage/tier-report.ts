import { type DayWindowQuery, FAST_CEILING, isCheaperRung, type TierReport, type UsageTurn } from "@intentic/sandbox-contract";
import type { UsageStore } from "./usage-store.js";

/* AUTOMATIC TIER SELECTION'S READOUT, the read half of the shadow ledger the judge has been writing since it
 * shipped (UsageTurn.tierScore/tierRules/tierRouted/tierDenied). docs/model-routing-design.md §4 names the
 * numbers the feature cannot be defended without — the fast share, the money involved, and the escalation
 * rate — and until this file existed they were recorded and unreadable, which is a settings row promising a
 * spend history nobody built.
 *
 * A TALLY, NOT AN EXPERIMENT, and the distinction is why this does not reuse turn-experiments.ts: those compare
 * two randomized arms of one population, while routing follows the settings mode, which follows time. Dressing
 * these counts in arms and margins would claim a control group that does not exist. What CAN be said honestly
 * is what was observed and what was done: how many turns looked simple, what the ones that stayed on the pick
 * cost there, what the moved ones cost on the cheap rung, and how often the user overruled the judge.
 *
 * NO COUNTERFACTUAL, deliberately. The ledger holds what turns cost, never what they would have cost on a model
 * they did not run, so `atStakeUsd` is labelled as the money the fast-judged turns actually spent — an upper
 * bound on any saving — rather than dressed up as one.
 *
 * THE ESCALATION READ is §4's strongest label: a fast-judged turn whose conversation's very NEXT row asks for a
 * dearer model is the user reaching for the picker right after a turn the judge called simple, inside the
 * product, in the direction that matters. It is derived here at read time rather than stored, because it is a
 * relationship between two rows and the rows are already on one ledger. */

// The same population rule the experiments use, for the same reason: a turn that died measures nothing, and a
// burst of auth refusals must not read as a flood of simple turns. A cancelled turn's judgement likewise
// describes how long the user waited, not the work. Absent outcome (old rows) stays.
const measurable = (turn: UsageTurn): boolean => turn.outcome !== "error" && turn.outcome !== "cancelled";

// Fast iff the stored score sits at or below the exported ceiling — the contract FAST_CEILING documents for
// exactly this read-back. The verdict itself is not stored; the score plus the ceiling it was judged against is.
const judgedFast = (turn: UsageTurn): boolean => turn.tierScore !== undefined && turn.tierScore <= FAST_CEILING;

// What the row ran, then what it asked for: `model` is resolved past every substitution, so it is the honest
// base for "did the next turn ask for something dearer than THIS one got".
const ranModel = (turn: UsageTurn): string | undefined => turn.model ?? turn.modelRequested;

/* Fast-judged turns whose conversation's next measurable row asked for a strictly dearer rung. `isCheaperRung`
 * answers "is the left a cheaper rung than the right", so a bump is exactly "what this turn ran is cheaper than
 * what the next turn asked for". Unrecognized families answer false on either side, which under-counts rather
 * than accuses — the correct direction for a guardrail read by a person deciding whether to trust the judge. */
const escalationsOf = (turns: readonly UsageTurn[]): number => {
    const byConversation = new Map<string, UsageTurn[]>();
    for (const turn of turns) {
        if (turn.conversationId === undefined) {
            continue;
        }
        const rows = byConversation.get(turn.conversationId);
        if (rows === undefined) {
            byConversation.set(turn.conversationId, [turn]);
        } else {
            rows.push(turn);
        }
    }
    let escalated = 0;
    for (const rows of byConversation.values()) {
        const ordered = rows.toSorted((left, right) => left.at - right.at);
        for (let index = 0; index < ordered.length - 1; index += 1) {
            const current = ordered[index];
            const next = ordered[index + 1];
            if (current === undefined || next === undefined || !judgedFast(current)) {
                continue;
            }
            const ran = ranModel(current);
            const asked = next.modelRequested ?? next.model;
            if (ran !== undefined && asked !== undefined && isCheaperRung(ran, asked)) {
                escalated += 1;
            }
        }
    }
    return escalated;
};

const spend = (rows: readonly UsageTurn[]): number => rows.reduce((total, turn) => total + turn.costUsd, 0);

// Undefined ⇒ nothing was judged in the window (autoTier "off" throughout, or no turns at all), which the
// screen renders as absence: "not measured" is the truth, zeros would read as "measured, found nothing".
export const readTierReport = async (usage: UsageStore, window: DayWindowQuery): Promise<TierReport | undefined> => {
    const turns = (await usage.turns(window)).filter(measurable);
    const judged = turns.filter((turn) => turn.tierScore !== undefined);
    if (judged.length === 0) {
        return undefined;
    }
    const fast = judged.filter(judgedFast);
    const routed = judged.filter((turn) => turn.tierRouted === true);
    return {
        judged: judged.length,
        fast: fast.length,
        atStakeUsd: spend(fast.filter((turn) => turn.tierRouted !== true)),
        routed: routed.length,
        routedUsd: spend(routed),
        escalated: escalationsOf(judged),
        denied: judged.filter((turn) => turn.tierDenied === true).length,
    };
};
