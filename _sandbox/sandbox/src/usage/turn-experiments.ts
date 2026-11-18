import { MECHANISMS, measureExperiment, type Design } from "@intentic/agent-context/arm-stats";
import { capabilitiesOf } from "@intentic/sandbox-contract/models/agent-catalog";
import { AgentHarnessSchema } from "@intentic/sandbox-contract/schemas/agent";
import type { DayWindowQuery, UsageTurn } from "@intentic/sandbox-contract/schemas/providers/usage";
import type { SavingsReport } from "@intentic/sandbox-contract/schemas/settings";
import { opt } from "../opt.js";
import type { UsageStore } from "./usage-store.js";

// The mechanism experiments (project map, tool search, stable prompt, cold trim) measured off the usage ledger. The iq
// search teaching was one until iq was removed (2026-11-18); its rows stay in the ledger and nothing reads them.
// What each is judged on and the arithmetic over its two arms are @intentic/agent-context's, shared with the Claude Code
// plugin's stats; this module only says where a ledger row keeps each experiment's arm and treatment revision.

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

export const readTurnExperiments = async (
    usage: UsageStore,
    window: DayWindowQuery,
): Promise<Pick<SavingsReport, "map" | "toolSearch" | "stablePrompt" | "coldTrim">> => {
    const turns = (await usage.turns(window)).filter(measurable);
    return {
        ...opt("map", measureExperiment(withinOneLoop(turns, MAP_DESIGN), MAP_DESIGN)),
        ...opt("toolSearch", measureExperiment(turns, TOOL_SEARCH_DESIGN)),
        ...opt("stablePrompt", measureExperiment(turns, STABLE_PROMPT_DESIGN)),
        ...opt("coldTrim", measureExperiment(turns, COLD_TRIM_DESIGN)),
    };
};
