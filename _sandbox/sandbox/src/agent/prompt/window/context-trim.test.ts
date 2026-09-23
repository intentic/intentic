import { LOCAL_MODEL_WINDOW_DEFAULT, type TurnNote } from "@intentic/sandbox-contract";
import { test, expect } from "bun:test";
import { applyTrim, trimFrame, trimState, type TurnTrim, turnTrim } from "./context-trim.js";
import { SKILL_CATALOG_NOTE_TITLE } from "../../../store/loaded-skills.js";
import { PERSONA_NOTE_TITLE } from "../../../personas/personas.js";
import { HANDOFF_STATE_NOTE_TITLE } from "../handoff-state.js";
import { GUIDANCE_TITLE } from "../guidance.js";
import { WORKSPACE_MAP_NOTE_TITLE } from "../workspace-map.js";
import { MEMORY_NOTE_TITLE } from "../workspace-memory.js";
import { WORKTREE_NOTE_TITLE } from "../turn-preamble.js";

// What a model's own window makes the sandbox stop composing, and what it then says it stopped composing.

const note = (title: string): TurnNote => ({ title, text: `## ${title}\n\nbody` });

// The tier boundaries are the local-model card's own rungs, read from the contract rather than transcribed, so the
// cases move when the card's decision moves.
const FULL = Number(LOCAL_MODEL_WINDOW_DEFAULT);

test("a window that holds a full turn trims nothing", () => {
    expect(turnTrim(FULL, "replace")).toBeUndefined();
    expect(turnTrim(200_000, "replace")).toBeUndefined();
});

// Unknown is not small. Every native subscription and every server that publishes no window lands here, which is most
// of the product, so a wrong answer would be a wrong answer everywhere.
test("an unknown window trims nothing", () => {
    expect(turnTrim(undefined, "replace")).toBeUndefined();
});

test("one rung under a full turn sheds what is optional and keeps the base", () => {
    const trim = turnTrim(FULL - 1, "replace");

    expect(trim?.tier).toBe("lean");
    expect(trim?.guidance).toBe(true);
    expect(trim?.fieldNotes).toBe(true);
    expect(trim?.base).toBe(false);
});

test("two rungs under, the base goes too", () => {
    expect(turnTrim(16_384, "replace")?.tier).toBe("minimal");
    expect(turnTrim(16_384, "replace")?.base).toBe(true);
});

// A runtime that can only add to its own instructions has no base to swap, and the notice must not claim one was.
test("a runtime that cannot replace its base keeps it whatever the window says", () => {
    expect(turnTrim(16_384, "append")?.base).toBe(false);
    expect(turnTrim(16_384, "none")?.base).toBe(false);
    // Still the smallest tier: the window is what it is, only the one thing it cannot do is not done.
    expect(turnTrim(16_384, "append")?.tier).toBe("minimal");
});

// The state a turn starts from, with nothing taken from the system prompt unless a case says so.
const started = (trim: TurnTrim | undefined, system = { guidance: false, fieldNotes: false }) =>
    trim === undefined ? undefined : trimState(trim, system);

// The set a small window may take is exactly the set a persona card may take. Anything outside it either keeps the
// turn on its own branch or explains a missing capability, and a small window is not a reason to become unsafe.
test("the notes no card may drop are the notes a window may not drop either", () => {
    const composed = [
        note(PERSONA_NOTE_TITLE),
        note(WORKTREE_NOTE_TITLE),
        note(WORKSPACE_MAP_NOTE_TITLE),
        note(SKILL_CATALOG_NOTE_TITLE),
        note(MEMORY_NOTE_TITLE),
    ];

    const { notes, state } = applyTrim(started(turnTrim(16_384, "replace")), composed);

    expect(notes.map((kept) => kept.title)).toEqual([PERSONA_NOTE_TITLE, WORKTREE_NOTE_TITLE, MEMORY_NOTE_TITLE]);
    expect(state?.omitted).toEqual([WORKSPACE_MAP_NOTE_TITLE, SKILL_CATALOG_NOTE_TITLE]);
});

test("no trim leaves the composed list exactly as it was", () => {
    const composed = [note(WORKSPACE_MAP_NOTE_TITLE), note(PERSONA_NOTE_TITLE)];

    expect(applyTrim(undefined, composed).notes).toEqual(composed);
    expect(trimFrame(applyTrim(undefined, composed).state)).toBeUndefined();
});

// The route assembles two notes AFTER planning (the repo-sync advisory, the hand-off state). They reach the window
// last and must meet the same one, and the reader must be shown one list rather than each place's own.
test("notes added after planning face the same window, and land in the same list", () => {
    const planning = applyTrim(started(turnTrim(16_384, "replace")), [note(WORKSPACE_MAP_NOTE_TITLE)]);

    const late = applyTrim(planning.state, [...planning.notes, note(HANDOFF_STATE_NOTE_TITLE)]);

    expect(late.notes.map((kept) => kept.title)).toEqual([]);
    expect(trimFrame(late.state)?.omitted).toEqual([WORKSPACE_MAP_NOTE_TITLE, HANDOFF_STATE_NOTE_TITLE]);
});

// THE PROPERTY THE NOTICE LIVES OR DIES ON: it may only name what the turn was actually going to send. A note the card
// had already dropped, or this turn was never owed, was not left out by the window.
test("the notice names only what was actually removed", () => {
    const trim = turnTrim(16_384, "replace")!;

    const { state } = applyTrim(trimState(trim, { guidance: true, fieldNotes: false }), [note(WORKSPACE_MAP_NOTE_TITLE)]);
    const frame = trimFrame(state);

    expect(frame?.omitted).toEqual([WORKSPACE_MAP_NOTE_TITLE, GUIDANCE_TITLE]);
    expect(frame?.window).toBe(16_384);
    expect(frame?.base).toBe(true);
});

// A lean turn that was composing nothing optional anyway has nothing to disclose, and saying so would be noise on
// every message.
test("a lean turn that lost nothing says nothing", () => {
    expect(trimFrame(started(turnTrim(FULL - 1, "replace")))).toBeUndefined();
});

// A swapped base is itself the disclosure, even when the turn was carrying no optional notes at all.
test("a swapped base always speaks", () => {
    expect(trimFrame(started(turnTrim(16_384, "replace")))).toMatchObject({ base: true, omitted: [] });
});
