import { type AgentCapabilities, type ContextTrim, LOCAL_MODEL_WINDOW_DEFAULT, LOCAL_MODEL_WINDOWS, type TurnNote } from "@intentic/sandbox-contract";
import { FIELD_NOTES_NOTE_TITLE } from "../field-notes.js";
import { GUIDANCE_TITLE } from "../guidance.js";
import type { PromptTrim } from "../system-prompt.js";
import { BRIEFING_NOTE_TITLES } from "../turn-briefing.js";

// Tiers are read off the local-model card's window rungs, never off the harness floor estimate in context-budget.ts.

// At or above the card's default rung nothing is shed; raising it there raises this.
const FULL_TURN_WINDOW = Number(LOCAL_MODEL_WINDOW_DEFAULT);

// Below this rung the base prompt itself is swapped, where the runtime lets it be replaced.
const LEAN_WINDOW = Number(LOCAL_MODEL_WINDOWS[1]);

// Every trim sheds the guidance, the field notes and each note a persona card may drop; only the base swap is by size.
export interface TurnTrim {
    readonly window: number;
    // Below the lean rung, and only where the runtime's instructions are `replace`: an appending runtime's is not ours.
    readonly base: boolean;
}

// Undefined means compose everything; an unknown window is never trimmed.
export const turnTrim = (window: number | undefined, instructions: AgentCapabilities["instructions"]): TurnTrim | undefined =>
    window === undefined || window >= FULL_TURN_WINDOW ? undefined : { window, base: window < LEAN_WINDOW && instructions === "replace" };

// One converter for the composer (turnPromptPlacement) and the adapter (sdkSystemPrompt), so built and sent agree.
export const promptTrim = (trim: TurnTrim | undefined): PromptTrim | undefined =>
    trim === undefined ? undefined : { guidance: true, base: trim.base };

// The fixtures (rules, persona, file locations, gate notes) carry titles no card may drop, so a window never sheds them.
const SHED_TITLES: ReadonlySet<string> = new Set(Object.values(BRIEFING_NOTE_TITLES).flat());

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
    const shed = new Set(notes.filter((note) => SHED_TITLES.has(note.title)));
    return {
        notes: notes.filter((note) => !shed.has(note)),
        state: { ...state, omitted: [...state.omitted, ...[...shed].map((note) => note.title)] },
    };
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
