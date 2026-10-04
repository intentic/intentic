import { MECHANISMS, measureExperiment, type Design, type MeasuredTurn } from "@intentic/agent-context/arm-stats";
import type { DayWindowQuery, SavingsReport, UsageTurn } from "@intentic/sandbox-contract";
import { opt } from "../opt.js";
import type { UsageStore } from "./usage-store.js";

// The mechanism experiments (iq search teaching, project map, field notes, guidance form) measured off the usage ledger.
// What each is judged on and the arithmetic over its two arms are @intentic/agent-context's, shared with the Claude Code
// plugin's stats; this module only says where a ledger row keeps each experiment's arm and treatment revision.

const SEARCH_DESIGN: Design<UsageTurn> = { ...MECHANISMS.search, arm: (turn) => turn.iqSearchArm, cohort: (turn) => turn.iqSearchCohort };

// The map has no revisions to cohort by: it is recomputed from the filesystem on every send.
const MAP_DESIGN: Design<UsageTurn> = { ...MECHANISMS.map, arm: (turn) => turn.mapArm, cohort: () => undefined };

// Cohorted, unlike the map, because the file is rewritten monthly and a window wide enough to reach MIN_ARM_TURNS is
// wide enough to hold two revisions.
const NOTES_DESIGN: Design<UsageTurn> = { ...MECHANISMS.notes, arm: (turn) => turn.notesArm, cohort: (turn) => turn.notesCohort };

// `on` is the lean form.
const GUIDANCE_DESIGN: Design<MeasuredUsageTurn> = { ...MECHANISMS.guidance, arm: (turn) => turn.guidanceArm, cohort: (turn) => turn.guidanceCohort };

// `on` has its old tool results replaced. No revisions yet: the limits are constants (tool-result-clearing.ts).
const CLEARING_DESIGN: Design<MeasuredUsageTurn> = { ...MECHANISMS.clearing, arm: (turn) => turn.clearingArm, cohort: () => undefined };

const measurable = (turn: UsageTurn): boolean => turn.outcome !== "error" && turn.outcome !== "cancelled";

// A ledger row with its per-call readings: the row's `turns` is the provider's count of model calls, which the Claude
// Code loop reports per call made and every other runtime reports as 1 for the whole exchange, so only the former is a
// round trip count, and only it divides the turn's prompt tokens into what one call carried.
type MeasuredUsageTurn = UsageTurn & Pick<MeasuredTurn, "roundTrips" | "contextPerCall">;
const withPerCall = (turn: UsageTurn): MeasuredUsageTurn => {
    if (turn.harness !== "claude-code" || turn.turns < 1) {
        return turn;
    }
    const prompt = turn.inputTokens + turn.cacheReadTokens + turn.cacheCreationTokens;
    return { ...turn, roundTrips: turn.turns, contextPerCall: prompt / turn.turns };
};

export const readTurnExperiments = async (
    usage: UsageStore,
    window: DayWindowQuery,
): Promise<Pick<SavingsReport, "search" | "map" | "notes" | "guidance" | "clearing">> => {
    const turns = (await usage.turns(window)).filter(measurable).map(withPerCall);
    const search = measureExperiment(turns, SEARCH_DESIGN);
    const map = measureExperiment(turns, MAP_DESIGN);
    const notes = measureExperiment(turns, NOTES_DESIGN);
    const guidance = measureExperiment(turns, GUIDANCE_DESIGN);
    const clearing = measureExperiment(turns, CLEARING_DESIGN);
    return {
        ...(search !== undefined ? { search } : {}),
        ...(map !== undefined ? { map } : {}),
        ...(notes !== undefined ? { notes } : {}),
        ...(guidance !== undefined ? { guidance } : {}),
        ...opt("clearing", clearing),
    };
};
