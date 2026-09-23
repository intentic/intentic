import { createHash } from "node:crypto";
import type { SandboxSettings, TurnNote } from "@intentic/sandbox-contract";
import type { FieldNotes } from "../../prompt/field-notes.js";
import { WORKSPACE_MAP_NOTE_TITLE } from "../../prompt/workspace-map.js";
import { opt } from "../../../opt.js";
import type { TurnContextOutcome, TurnContextSkip } from "../turn/turn-context.js";
import type { TurnExperimentStamps } from "../turn/turn-plan.js";

// The per-turn A/B experiments, one declaration each: the salt a conversation's arm is drawn with, the settings that
// switch it on and hold conversations out of it, and the ledger fields it stamps. usage/turn-experiments.ts reads them.

// Deterministic per conversation id, with no state stored. `experiment` salts the hash so two experiments draw
// independent buckets for the same conversation instead of always agreeing.
export const conversationExperimentArm = (experiment: string, conversationId: string | undefined, holdout: number): boolean => {
    if (conversationId === undefined) {
        return Math.random() >= holdout;
    }
    const bucket = createHash("sha256").update(`${experiment}:${conversationId}`).digest().readUInt32BE(0) / 0x1_0000_0000;
    return bucket >= holdout;
};

// The field notes as one turn sees them: the arm it drew, the brief it read, and what (if anything) it was sent. Read on
// both arms, so a control turn can name the revision it was withheld from.
export interface TurnFieldNotes {
    readonly arm: boolean | undefined;
    readonly brief: FieldNotes | undefined;
    readonly note: string | undefined;
}

// What one turn measured of each experiment: the only input its stamps are written from.
export interface ExperimentReadings {
    readonly iqSearch: { readonly arm: boolean | undefined; readonly cohort: string | undefined };
    // The notes as the turn sends them, trimmed: the map's size is read off what was composed, not the decision to send.
    readonly workspaceMap: { readonly arm: boolean | undefined; readonly notes: readonly TurnNote[] | undefined };
    readonly fieldNotes: TurnFieldNotes;
    // Undefined when retrieval was never attempted, which is a different fact from a lookup that skipped.
    readonly turnContext: TurnContextOutcome | undefined;
}

interface Experiment<Reading> {
    // Hashed with the conversation id and never renamed: a new salt re-draws the arm of every running conversation.
    readonly salt: string;
    readonly on: (settings: SandboxSettings) => boolean;
    // The share of conversations held out as control; 0 measures nothing.
    readonly holdout: (settings: SandboxSettings) => number;
    // Fields are omitted, never defaulted: absent reads as unmeasured, and zero would read as a measured nothing.
    readonly stamps: (reading: Reading) => TurnExperimentStamps;
}

// Annotated, not inferred: a nested ternary over a literal and a union widens to `string`.
const deliveryOf = (outcome: TurnContextOutcome | undefined): TurnContextSkip | "delivered" | undefined =>
    outcome === undefined ? undefined : "note" in outcome ? "delivered" : outcome.skipped;

export const EXPERIMENTS: { readonly [K in keyof ExperimentReadings]: Experiment<ExperimentReadings[K]> } = {
    iqSearch: {
        salt: "iq-search",
        on: (settings) => settings.iqSearch,
        holdout: (settings) => settings.iqSearchHoldout,
        // A cohort only beside its arm: on an unmeasured turn it names a revision nothing was compared against.
        stamps: ({ arm, cohort }) => ({ ...opt("iqSearchArm", arm), ...opt("iqSearchCohort", arm === undefined ? undefined : cohort) }),
    },
    workspaceMap: {
        salt: "workspace-map",
        on: (settings) => settings.workspaceMap,
        holdout: (settings) => settings.workspaceMapHoldout,
        stamps: ({ arm, notes }) => ({
            ...opt("mapArm", arm),
            ...opt("mapChars", notes?.find((note) => note.title === WORKSPACE_MAP_NOTE_TITLE)?.text.length),
        }),
    },
    fieldNotes: {
        salt: "field-notes",
        on: (settings) => settings.fieldNotes,
        holdout: (settings) => settings.fieldNotesHoldout,
        // Chars only when sent, since a brief read but withheld cost nothing; the cohort even on control turns, to pair them.
        stamps: ({ arm, brief, note }) => ({
            ...opt("notesArm", arm),
            ...opt("notesChars", note === undefined ? undefined : brief?.chars),
            ...opt("notesCohort", brief?.revision),
        }),
    },
    // Also behind env.config.ts iqTurnContext, and holding nobody out until re-measured, so it stamps delivery, not assignment.
    turnContext: {
        salt: "turn-context",
        on: (settings) => settings.iqSearch,
        holdout: () => 0,
        stamps: (outcome) => ({ ...opt("turnContext", deliveryOf(outcome)), ...opt("turnContextMs", outcome?.durationMs) }),
    },
};

// Undefined means not measuring (switched off, no holdout, or no conversation to hold out), which readers treat as no
// experiment rather than as a control turn.
export const armOf = <Reading>(
    experiment: Experiment<Reading>,
    settings: SandboxSettings,
    conversationId: string | undefined,
): boolean | undefined => {
    const holdout = experiment.holdout(settings);
    return experiment.on(settings) && holdout > 0 && conversationId !== undefined
        ? conversationExperimentArm(experiment.salt, conversationId, holdout)
        : undefined;
};

const stampsOf = <K extends keyof ExperimentReadings>(key: K, readings: ExperimentReadings): TurnExperimentStamps =>
    EXPERIMENTS[key].stamps(readings[key]);

// In registry order after the turn index, so a new experiment reaches the ledger by being declared above, never by
// being listed a second time here.
export const experimentStamps = (turnIndex: number | undefined, readings: ExperimentReadings): TurnExperimentStamps =>
    (Object.keys(EXPERIMENTS) as (keyof ExperimentReadings)[]).reduce<TurnExperimentStamps>(
        (stamps, key) => Object.assign(stamps, stampsOf(key, readings)),
        { ...opt("turnIndex", turnIndex) },
    );
