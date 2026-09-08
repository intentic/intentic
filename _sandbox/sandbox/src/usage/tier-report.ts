import { type DayWindowQuery, FAST_CEILING, isCheaperRung, type TierReport, type UsageTurn } from "@intentic/sandbox-contract";
import type { UsageStore } from "./usage-store.js";

// Read half of automatic tier selection's shadow ledger (docs/model-routing-design.md §4): fast share, money at stake,
// escalation rate. A tally, not an experiment: routing follows settings mode, not a randomized control, so `atStakeUsd`
// is an upper bound on saving, never a counterfactual.

// Same population rule the experiments use: a dead turn measures nothing, so refusals don't read as simple turns, and a
// cancelled turn's judgement describes the wait, not the work.
const measurable = (turn: UsageTurn): boolean => turn.outcome !== "error" && turn.outcome !== "cancelled";

// Recorded verdict if there is one; rows from before the eagerness knob only carry a score, judged at the balanced
// cutoff FAST_CEILING still is, so the fallback matches how they were actually judged, not a guess.
const judgedFast = (turn: UsageTurn): boolean =>
    turn.tierFast ?? (turn.tierScore !== undefined && turn.tierScore <= (turn.tierCeiling ?? FAST_CEILING));

// What the row ran, or else what it asked for; `model` is resolved past every substitution, the honest base for
// comparing to the next turn's ask.
const ranModel = (turn: UsageTurn): string | undefined => turn.model ?? turn.modelRequested;

// Fast-judged turns whose conversation's next row asked for a strictly dearer rung (isCheaperRung). Unrecognised
// families answer false either way, under-counting rather than accusing.
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

// Undefined means nothing was judged in the window (autoTier off throughout, or no turns), rendered as absence: "not
// measured" rather than zeros reading as "measured, found nothing".
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
