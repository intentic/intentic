import { MECHANISMS, measureExperiment, type Design } from "@intentic/agent-context/arm-stats";
import type { DayWindowQuery, SavingsReport, UsageTurn } from "@intentic/sandbox-contract";
import type { UsageStore } from "./usage-store.js";

// The mechanism experiments (iq search teaching, project map, field notes) measured off the usage ledger.
// What each is judged on and the arithmetic over its two arms are @intentic/agent-context's, shared with the Claude Code
// plugin's stats; this module only says where a ledger row keeps each experiment's arm and treatment revision.

// Cohort hashes that name one treatment under two spellings, read as the earlier one. `afccafc52ce9` is what
// fcf9970ffa's hash of `af7b1874e40c`'s words came out as once the lean line left the hash input (2026-10-06): the nudge and
// the full search line are byte-identical, and the lean line went to both arms alike, so splitting them only halved
// the sample.
const SAME_IQ_TEACHING: Readonly<Record<string, string>> = { afccafc52ce9: "af7b1874e40c" };
const iqCohortOf = (turn: UsageTurn): string | undefined =>
    turn.iqSearchCohort === undefined ? undefined : (SAME_IQ_TEACHING[turn.iqSearchCohort] ?? turn.iqSearchCohort);

const SEARCH_DESIGN: Design<UsageTurn> = { ...MECHANISMS.search, arm: (turn) => turn.iqSearchArm, cohort: iqCohortOf };

// Cohorted by comparison rather than by revision (the map is recomputed on every send): the current rows are read apart
// from the comparisons before them (experiments.ts MAP_COMPARISON). Every earlier one also compared the map against none
// and may stand in while the current one is early, except the compact-vs-full rows, whose arms were two maps.
const OTHER_MAP_COMPARISONS: ReadonlySet<string | undefined> = new Set(["compact-vs-full"]);
const MAP_DESIGN: Design<UsageTurn> = {
    ...MECHANISMS.map,
    arm: (turn) => turn.mapArm,
    cohort: (turn) => turn.mapCohort,
    comparable: (cohort) => !OTHER_MAP_COMPARISONS.has(cohort),
};

// Cohorted, unlike the map, because the file is rewritten monthly and a window wide enough to reach MIN_ARM_TURNS is
// wide enough to hold two revisions.
const NOTES_DESIGN: Design<UsageTurn> = { ...MECHANISMS.notes, arm: (turn) => turn.notesArm, cohort: (turn) => turn.notesCohort };

const measurable = (turn: UsageTurn): boolean => turn.outcome !== "error" && turn.outcome !== "cancelled";

export const readTurnExperiments = async (
    usage: UsageStore,
    window: DayWindowQuery,
): Promise<Pick<SavingsReport, "search" | "map" | "notes">> => {
    const turns = (await usage.turns(window)).filter(measurable);
    const search = measureExperiment(turns, SEARCH_DESIGN);
    const map = measureExperiment(turns, MAP_DESIGN);
    const notes = measureExperiment(turns, NOTES_DESIGN);
    return {
        ...(search !== undefined ? { search } : {}),
        ...(map !== undefined ? { map } : {}),
        ...(notes !== undefined ? { notes } : {}),
    };
};
