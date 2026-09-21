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

// What a turn stops composing when the model's own window cannot hold one. The sibling of context-budget.ts: that
// answers "can this fit at all" and refuses; this answers "how much of this window may the sandbox spend on itself"
// and gives the rest back before anything is built.
//
// THE NUMBER THIS DOES NOT USE is the harness floor. The floor is an estimate (context-budget.ts states its own), it
// is already load-bearing twice, and any budget that divides a remainder by it inherits the estimate's error — which
// on the windows this is for is larger than the whole preamble it would be dividing. The rungs below are a product
// decision already made and already priced on the local-model card, so the tier is read off them instead and cannot be
// wrong about a number nobody measured.

// The smallest window the local-model card calls "a full turn fits", read from the same constant the card defaults to,
// so raising it there raises this. At or above it nothing is shed.
const FULL_TURN_WINDOW = Number(LOCAL_MODEL_WINDOW_DEFAULT);

// One rung further down (32k). Below it the loop's own base instructions are themselves a large share of the request,
// and they are the only thing left to give back once everything optional is already gone.
const LEAN_WINDOW = Number(LOCAL_MODEL_WINDOWS[1]);

// Every note a persona card is allowed to drop, which is exactly the set this may drop too. The ones no card may drop
// — where the files live, who the turn is acting as, the owner's standing rules, the two that explain a missing
// account, the slash guard — are the ones whose absence changes what a turn is ALLOWED to do rather than what it
// knows, and a small window is not a reason to become unsafe.
const SHED: ReadonlySet<TurnBriefingNoteId> = new Set(TURN_BRIEFING_NOTES.map((note) => note.id));

export interface TurnTrim {
    // Named for the log line and the tests; the wire frame carries `base` instead, since what a reader needs is what
    // happened, not which rung decided it.
    readonly tier: "lean" | "minimal";
    readonly window: number;
    // Whether this window pays for a given preamble note, asked once per composed note by applyTrim.
    readonly sheds: (id: TurnBriefingNoteId) => boolean;
    // Both tiers: this product's guidance and the sandbox's field notes are the two largest things it composes that
    // are neither the owner's words nor a safety note. `guidance` is applied where the prompt is composed
    // (system-prompt.ts), `fieldNotes` a step earlier, where the turn decides whether to read the brief at all.
    readonly guidance: true;
    readonly fieldNotes: true;
    // `minimal`, and only where the runtime lets its base be replaced at all. On a runtime that can only append, the
    // base is not ours to swap and this stays false rather than the notice claiming a swap that never happened.
    readonly base: boolean;
}

// Undefined means compose everything. An unknown window — a native subscription, a server that publishes none — is
// never trimmed, on the same rule context-budget.ts refuses on: unknown is unknown, and guessing small is the one
// error that would quietly make every turn in the product worse.
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

// The same decision as the prompt composer takes it. One converter, read by both the composition (turnPromptPlacement)
// and the adapter that sends it (sdkSystemPrompt), so the prompt built and the prompt sent cannot shed different
// things.
export const promptTrim = (trim: TurnTrim | undefined): PromptTrim | undefined =>
    trim === undefined ? undefined : { guidance: trim.guidance, base: trim.base };

// Which id a composed note belongs to, read backwards off the same map the card editor uses: a note carries a title,
// not an id, and a title that maps to nothing is a note no card may drop and this may not either.
const ID_BY_TITLE: ReadonlyMap<string, TurnBriefingNoteId> = new Map(
    (Object.entries(BRIEFING_NOTE_TITLES) as [TurnBriefingNoteId, readonly string[]][]).flatMap(([id, titles]) =>
        titles.map((title): [string, TurnBriefingNoteId] => [title, id]),
    ),
);

// The decision plus what it has taken so far, carried between the TWO places a turn's notes are assembled: planning,
// and the route that adds the repo-sync advisory and the hand-off state after it. One value rather than two passes,
// because notes added late must face the same window as the rest — the hand-off note is the largest of them — and
// because the reader is owed ONE list, not planning's and then the route's.
export interface TurnTrimState {
    readonly trim: TurnTrim;
    // What the window took from the SYSTEM prompt, which no note list can show: whether this product's guidance was
    // riding at all (a custom prompt has already dropped it, and a window cannot take what was not there), and whether
    // this turn had a field-notes brief to send.
    readonly system: { readonly guidance: boolean; readonly fieldNotes: boolean };
    // Titles taken so far, in the order a full turn would have read them.
    readonly omitted: readonly string[];
}

export const trimState = (trim: TurnTrim, system: TurnTrimState["system"]): TurnTrimState => ({ trim, system, omitted: [] });

// The filter, applied to a list composed as though nothing were being trimmed. That order is deliberate and is the
// whole reason the notice can be trusted: what a window LEFT OUT is only nameable by first building what the turn
// would otherwise have sent. The waste is one project-map walk per opening turn on a small model, daemon-side, and it
// buys a disclosure that can never name a note this turn was never going to send.
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

// A title that maps to no id is a note no card may drop, and this may not drop it either.
const sheds = (trim: TurnTrim, note: TurnNote): boolean => {
    const id = ID_BY_TITLE.get(note.title);
    return id !== undefined && trim.sheds(id);
};

// The frame, or undefined when the window took nothing a reader would recognise — the honest answer for a turn where
// every optional piece was already off. A swapped base is itself a disclosure, so it always speaks.
export const trimFrame = (state: TurnTrimState | undefined): ContextTrim | undefined => {
    if (state === undefined) {
        return undefined;
    }
    const { trim, system } = state;
    const omitted = [...state.omitted, ...(system.guidance ? [GUIDANCE_TITLE] : []), ...(system.fieldNotes ? [FIELD_NOTES_NOTE_TITLE] : [])];
    return omitted.length === 0 && !trim.base ? undefined : { window: trim.window, omitted, base: trim.base };
};
