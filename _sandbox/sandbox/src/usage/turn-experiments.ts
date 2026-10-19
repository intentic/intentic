import { MECHANISMS, measureExperiment, MIN_ARM_TURNS, type Design } from "@intentic/agent-context/arm-stats";
import { capabilitiesOf } from "@intentic/sandbox-contract/models/agent-catalog";
import { AgentHarnessSchema } from "@intentic/sandbox-contract/schemas/agent";
import type { DayWindowQuery, UsageTurn } from "@intentic/sandbox-contract/schemas/providers/usage";
import type { SavingsReport, TurnExperiment } from "@intentic/sandbox-contract/schemas/settings";
import { opt } from "../opt.js";
import type { UsageStore } from "./usage-store.js";

// The mechanism experiments (iq search teaching, project map, field notes, tool search, stable prompt, cold trim)
// measured off the usage ledger.
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
// One brief under three hashes, read as the current one. `8ce12338` hashed the whole file of 2026-10-06; `3b657c47` the
// same file plus a block the index never ranked (2026-10-12), which no turn was sent; `2eba3285` is how the revision
// hashes that brief since it covers only what can be sent (field-notes.ts). Split, the comparison restarted over an edit
// nobody received and set its first answer aside.
const SAME_NOTES_BRIEF: ReadonlyMap<string, string> = new Map([
    ["8ce12338", "2eba3285"],
    ["3b657c47", "2eba3285"],
]);
const NOTES_DESIGN: Design<UsageTurn> = {
    ...MECHANISMS.notes,
    arm: (turn) => turn.notesArm,
    cohort: (turn) => (turn.notesCohort === undefined ? undefined : (SAME_NOTES_BRIEF.get(turn.notesCohort) ?? turn.notesCohort)),
};

// No revisions to keep apart: the switch is the CLI's own, and the tool set it defers is whatever the turn mounted.
const TOOL_SEARCH_DESIGN: Design<UsageTurn> = { ...MECHANISMS.toolSearch, arm: (turn) => turn.toolSearchArm, cohort: () => undefined };
const STABLE_PROMPT_DESIGN: Design<UsageTurn> = { ...MECHANISMS.stablePrompt, arm: (turn) => turn.stablePromptArm, cohort: () => undefined };

const COLD_TRIM_DESIGN: Design<UsageTurn> = { ...MECHANISMS.coldTrim, arm: (turn) => turn.coldTrimArm, cohort: () => undefined };

const measurable = (turn: UsageTurn): boolean => turn.outcome !== "error" && turn.outcome !== "cancelled";

// The loop a row ran on: recorded since 2026-10-13, resolved before that from provider and harness the way the turn was
// (a harness this build no longer names reads as the provider's own loop).
const loopOf = (turn: UsageTurn): string => {
    if (turn.runtime !== undefined) {
        return turn.runtime;
    }
    const harness = AgentHarnessSchema.safeParse(turn.harness);
    return capabilitiesOf(turn.provider, harness.success ? harness.data : "native").runtime;
};

// Each loop counts on its own scale: Cursor and Gemini report almost no searches, Codex about twelve failed calls a turn
// to Claude Code's two. A comparison pooled across loops reads mostly their mix, so each is read within the one loop
// that ran the most of its conversations: Claude Code on a Claude sandbox, Codex on a Codex one. The tool-loading
// comparisons need none of this; they run on the Claude Code loop alone.
const withinOneLoop = (turns: readonly UsageTurn[], design: Design<UsageTurn>): readonly UsageTurn[] => {
    const conversations = new Map<string, Set<string>>();
    for (const turn of turns) {
        if (turn.conversationId !== undefined && design.arm(turn) !== undefined) {
            const loop = loopOf(turn);
            conversations.set(loop, (conversations.get(loop) ?? new Set()).add(turn.conversationId));
        }
    }
    const [busiest] = [...conversations].toSorted((left, right) => right[1].size - left[1].size)[0] ?? [];
    return busiest === undefined ? turns : turns.filter((turn) => loopOf(turn) === busiest);
};

const sumOf = (turns: readonly UsageTurn[], field: "searchCalls" | "iqSearches"): number => turns.reduce((sum, turn) => sum + (turn[field] ?? 0), 0);

// The share of each group's searches that ran iq, over the reading's own cohort: a teaching nobody takes up cannot move
// the readings, and they alone cannot say which happened. Pooled over turns, since it describes rather than compares.
const uptakeOf = (turns: readonly UsageTurn[], cohort: string | undefined): TurnExperiment["uptake"] => {
    const recorded = turns.filter((turn) => turn.iqSearches !== undefined && SEARCH_DESIGN.arm(turn) !== undefined && iqCohortOf(turn) === cohort);
    const share = (arm: boolean): number => {
        const group = recorded.filter((turn) => turn.iqSearchArm === arm);
        const searches = sumOf(group, "searchCalls");
        return searches === 0 ? 0 : Math.round((sumOf(group, "iqSearches") / searches) * 1000) / 1000;
    };
    const treated = recorded.filter((turn) => turn.iqSearchArm === true).length;
    return treated < MIN_ARM_TURNS ? undefined : { on: share(true), off: share(false), turns: treated };
};

const searchExperiment = (turns: readonly UsageTurn[]): TurnExperiment | undefined => {
    const experiment = measureExperiment(turns, SEARCH_DESIGN);
    const uptake = experiment === undefined ? undefined : uptakeOf(turns, experiment.cohort);
    return experiment === undefined || uptake === undefined ? experiment : { ...experiment, uptake };
};

export const readTurnExperiments = async (
    usage: UsageStore,
    window: DayWindowQuery,
): Promise<Pick<SavingsReport, "search" | "map" | "notes" | "toolSearch" | "stablePrompt" | "coldTrim">> => {
    const turns = (await usage.turns(window)).filter(measurable);
    return {
        ...opt("search", searchExperiment(withinOneLoop(turns, SEARCH_DESIGN))),
        ...opt("map", measureExperiment(withinOneLoop(turns, MAP_DESIGN), MAP_DESIGN)),
        ...opt("notes", measureExperiment(withinOneLoop(turns, NOTES_DESIGN), NOTES_DESIGN)),
        ...opt("toolSearch", measureExperiment(turns, TOOL_SEARCH_DESIGN)),
        ...opt("stablePrompt", measureExperiment(turns, STABLE_PROMPT_DESIGN)),
        ...opt("coldTrim", measureExperiment(turns, COLD_TRIM_DESIGN)),
    };
};
