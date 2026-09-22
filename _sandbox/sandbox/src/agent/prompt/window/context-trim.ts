import {
    type AgentCapabilities,
    type ContextTrim,
    LOCAL_MODEL_WINDOW_DEFAULT,
    LOCAL_MODEL_WINDOWS,
    TURN_BRIEFING_NOTES,
    type TurnBriefingNoteId,
    type TurnNote,
} from "@intentic/sandbox-contract";
import { FIELD_NOTES_NOTE_TITLE } from "../field-notes.js";
import { GUIDANCE_TITLE, type PromptTrim } from "../system-prompt.js";
import { BRIEFING_NOTE_TITLES } from "../turn-briefing.js";

// Tiers are read off the local-model card's window rungs, never off the harness floor estimate in context-budget.ts.

// At or above the card's default rung nothing is shed; raising it there raises this.
const FULL_TURN_WINDOW = Number(LOCAL_MODEL_WINDOW_DEFAULT);

// Below this rung the base prompt itself is swapped, where the runtime lets it be replaced.
const LEAN_WINDOW = Number(LOCAL_MODEL_WINDOWS[1]);

// Only the notes a persona card may drop; the fixtures (rules, persona, file locations, gate notes) are never shed.
const SHED: ReadonlySet<TurnBriefingNoteId> = new Set(TURN_BRIEFING_NOTES.map((note) => note.id));

export interface TurnTrim {
    readonly tier: "lean" | "minimal";
    readonly window: number;
    readonly sheds: (id: TurnBriefingNoteId) => boolean;
    // Both tiers shed both; `guidance` is applied in system-prompt.ts, `fieldNotes` where the brief is read.
    readonly guidance: true;
    readonly fieldNotes: true;
    // Only true when the runtime's instructions are `replace`; an appending runtime's base is not ours to swap.
    readonly base: boolean;
}

// Undefined means compose everything; an unknown window is never trimmed.
export const turnTrim = (window: number | undefined, instructions: AgentCapabilities["instructions"]): TurnTrim | undefined => {
    if (window === undefined || window >= FULL_TURN_WINDOW) {
        return undefined;
    }
    return {
        tier: window >= LEAN_WINDOW ? "lean" : "minimal",
        window,
        sheds: (id) => SHED.has(id),
        guidance: true,
        fieldNotes: true,
        base: window < LEAN_WINDOW && instructions === "replace",
    };
};

// One converter for the composer (turnPromptPlacement) and the adapter (sdkSystemPrompt), so built and sent agree.
export const promptTrim = (trim: TurnTrim | undefined): PromptTrim | undefined =>
    trim === undefined ? undefined : { guidance: trim.guidance, base: trim.base };

// A note carries a title, not an id; a title that maps to nothing is a note no card may drop.
const ID_BY_TITLE: ReadonlyMap<string, TurnBriefingNoteId> = new Map(
    (Object.entries(BRIEFING_NOTE_TITLES) as [TurnBriefingNoteId, readonly string[]][]).flatMap(([id, titles]) =>
        titles.map((title): [string, TurnBriefingNoteId] => [title, id]),
    ),
);

// Carried from planning to the route that adds late notes, so both face the same window and the reader gets one list.
export interface TurnTrimState {
    readonly trim: TurnTrim;
    // Whether guidance and a field-notes brief rode at all; a window cannot take what a custom prompt already dropped.
    readonly system: { readonly guidance: boolean; readonly fieldNotes: boolean };
    // Titles taken so far, in the order a full turn would have read them.
    readonly omitted: readonly string[];
}

export const trimState = (trim: TurnTrim, system: TurnTrimState["system"]): TurnTrimState => ({ trim, system, omitted: [] });

// Filters a list composed as though nothing were trimmed: the notice may only name notes the turn would have sent.
export const applyTrim = (
    state: TurnTrimState | undefined,
    notes: readonly TurnNote[],
): { readonly notes: TurnNote[]; readonly state: TurnTrimState | undefined } => {
    if (state === undefined) {
        return { notes: [...notes], state };
    }
    const shed = new Set(notes.filter((note) => sheds(state.trim, note)));
    return {
        notes: notes.filter((note) => !shed.has(note)),
        state: { ...state, omitted: [...state.omitted, ...[...shed].map((note) => note.title)] },
    };
};

const sheds = (trim: TurnTrim, note: TurnNote): boolean => {
    const id = ID_BY_TITLE.get(note.title);
    return id !== undefined && trim.sheds(id);
};

// Undefined when nothing a reader would recognise was taken; a swapped base always speaks.
export const trimFrame = (state: TurnTrimState | undefined): ContextTrim | undefined => {
    if (state === undefined) {
        return undefined;
    }
    const { trim, system } = state;
    const omitted = [...state.omitted, ...(system.guidance ? [GUIDANCE_TITLE] : []), ...(system.fieldNotes ? [FIELD_NOTES_NOTE_TITLE] : [])];
    return omitted.length === 0 && !trim.base ? undefined : { window: trim.window, omitted, base: trim.base };
};
