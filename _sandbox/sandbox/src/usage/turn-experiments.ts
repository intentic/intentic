import { MECHANISMS, measureExperiment, type Design } from "@intentic/agent-context/arm-stats";
import type { DayWindowQuery, SavingsReport, UsageTurn } from "@intentic/sandbox-contract";
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
const GUIDANCE_DESIGN: Design<UsageTurn> = { ...MECHANISMS.guidance, arm: (turn) => turn.guidanceArm, cohort: (turn) => turn.guidanceCohort };

const measurable = (turn: UsageTurn): boolean => turn.outcome !== "error" && turn.outcome !== "cancelled";

export const readTurnExperiments = async (
    usage: UsageStore,
    window: DayWindowQuery,
): Promise<Pick<SavingsReport, "search" | "map" | "notes" | "guidance">> => {
    const turns = (await usage.turns(window)).filter(measurable);
    const search = measureExperiment(turns, SEARCH_DESIGN);
    const map = measureExperiment(turns, MAP_DESIGN);
    const notes = measureExperiment(turns, NOTES_DESIGN);
    const guidance = measureExperiment(turns, GUIDANCE_DESIGN);
    return {
        ...(search !== undefined ? { search } : {}),
        ...(map !== undefined ? { map } : {}),
        ...(notes !== undefined ? { notes } : {}),
        ...(guidance !== undefined ? { guidance } : {}),
    };
};
