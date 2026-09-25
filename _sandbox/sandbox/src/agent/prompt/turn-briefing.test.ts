import { type Persona, type TurnBriefingNoteId, type TurnNote, TURN_BRIEFING_FIXTURES, TURN_BRIEFING_NOTES } from "@intentic/sandbox-contract";
import { LANDING_CHECKS_NOTE_TITLE } from "../../workspace/deps/mainline-note.js";
import { SETUP_NOTICE_TITLE, STALE_NOTICE_TITLE } from "../../workspace/layout/workspace-setup.js";
import { PERSONA_NOTE_TITLE } from "../../personas/personas.js";
import { HANDOFF_STATE_NOTE_TITLE } from "./handoff-state.js";
import { BRIEFING_NOTE_TITLES, briefingLabelMismatches, briefingOf } from "./turn-briefing.js";
import { WORKSPACE_MAP_NOTE_TITLE } from "./workspace-map.js";

// The card's deny list is matched against note titles, so the two claims this file holds are the ones types cannot:
// that the editor's words are the transcript's words, and that a note nobody may drop stays put.

const cardOmitting = (...omit: readonly TurnBriefingNoteId[]): Persona => ({ id: "lean", capabilities: [], briefing: { omit: [...omit] } });

const titled = (...titles: readonly string[]): TurnNote[] => titles.map((title) => ({ title, text: `${title} body` }));

test("every switch in the card editor is named with the title the transcript shows for it", () => {
    expect(briefingLabelMismatches()).toEqual([]);
});

test("a note the editor calls always-sent has no id a card could name", () => {
    const droppable = new Set(Object.values(BRIEFING_NOTE_TITLES).flat());
    expect(TURN_BRIEFING_FIXTURES.filter((fixture) => droppable.has(fixture.label))).toEqual([]);
});

test("no card, and a card that named nothing, both read as every note sent", () => {
    const notes = titled(WORKSPACE_MAP_NOTE_TITLE, HANDOFF_STATE_NOTE_TITLE);

    expect(briefingOf(undefined).keep(notes)).toEqual(notes);
    expect(briefingOf({ id: "open", capabilities: [] }).keep(notes)).toEqual(notes);
    expect(briefingOf(undefined).sends("map")).toBe(true);
});

test("a named id drops its note and leaves every other one standing", () => {
    const briefing = briefingOf(cardOmitting("map", "handoff"));

    expect(briefing.sends("map")).toBe(false);
    expect(briefing.sends("checks")).toBe(true);
    expect(briefing.keep(titled(WORKSPACE_MAP_NOTE_TITLE, LANDING_CHECKS_NOTE_TITLE, HANDOFF_STATE_NOTE_TITLE))).toEqual(
        titled(LANDING_CHECKS_NOTE_TITLE),
    );
});

test("dropping the dependency notice drops both of its wordings, since they are one question", () => {
    const briefing = briefingOf(cardOmitting("dependencies"));

    expect(briefing.keep(titled(SETUP_NOTICE_TITLE, STALE_NOTICE_TITLE))).toEqual([]);
});

test("a note with no id at all passes even the most trimmed card untouched", () => {
    const briefing = briefingOf(cardOmitting(...TURN_BRIEFING_NOTES.map((note) => note.id)));

    expect(briefing.keep(titled(PERSONA_NOTE_TITLE))).toEqual(titled(PERSONA_NOTE_TITLE));
});
