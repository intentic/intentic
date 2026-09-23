import { type Persona, type TurnBriefingNoteId, type TurnNote, TURN_BRIEFING_FIXTURES, TURN_BRIEFING_NOTES } from "@intentic/sandbox-contract";
import { CONTEXT_NOTE_TITLE } from "../context/context-note.js";
import { SPAWN_NOTE_TITLE } from "../subagents/spawn-note.js";
import { PERSONA_NOTE_TITLE, UNATTENDED_ACCOUNTS_TITLE } from "../../personas/personas.js";
import { TURN_ENDING_NOTE_TITLE } from "../../rules/turn-ending-note.js";
import { GATED_CREDENTIALS_TITLE } from "../../secrets/credential-gating.js";
import { SKILL_CATALOG_NOTE_TITLE } from "../../store/loaded-skills.js";
import { REPO_SYNC_NOTE_TITLE } from "../../workspace/layout/sync-repos.js";
import { SETUP_NOTICE_TITLE, STALE_NOTICE_TITLE } from "../../workspace/layout/workspace-setup.js";
import { HANDOFF_STATE_NOTE_TITLE } from "./handoff-state.js";
import { IQ_SEARCH_INSTRUCTION_TITLE } from "./iq-search-instruction.js";
import { LITERAL_SLASH_NOTE, WORKTREE_NOTE_TITLE } from "./turn-preamble.js";
import { MEMORY_NOTE_TITLE } from "./workspace-memory.js";
import { WORKSPACE_MAP_NOTE_TITLE } from "./workspace-map.js";

// Which of the sandbox's own preamble notes a card still wants. The card names ids; the notes themselves are titled
// prose written at a dozen sites, so this is the one place the two meet.

// Each id's titles, imported from the note's own definition rather than restated, so rewording a title moves both
// halves at once. A `Record` over the id union, so adding an id to the contract fails to compile until it is mapped.
export const BRIEFING_NOTE_TITLES: Record<TurnBriefingNoteId, readonly string[]> = {
    map: [WORKSPACE_MAP_NOTE_TITLE],
    context: [CONTEXT_NOTE_TITLE],
    skills: [SKILL_CATALOG_NOTE_TITLE],
    search: [IQ_SEARCH_INSTRUCTION_TITLE],
    delegation: [SPAWN_NOTE_TITLE],
    checks: [TURN_ENDING_NOTE_TITLE],
    // One switch over two notices: missing and behind are the same question asked of a workspace in two states.
    dependencies: [SETUP_NOTICE_TITLE, STALE_NOTICE_TITLE],
    repoSync: [REPO_SYNC_NOTE_TITLE],
    handoff: [HANDOFF_STATE_NOTE_TITLE],
};

export interface TurnBriefing {
    // Whether this turn's card still wants a given note, asked before composing an expensive one.
    readonly sends: (id: TurnBriefingNoteId) => boolean;
    // The same answer applied to an assembled list. Title-matched, so a note the card never named passes through
    // untouched — including every note that has no id here at all, which is how the non-negotiable ones stay.
    readonly keep: (notes: readonly TurnNote[]) => TurnNote[];
}

// Nothing dropped: an unpinned turn, a card with no briefing block, and a card that named nothing all read the same.
const FULL_BRIEFING: TurnBriefing = { sends: () => true, keep: (notes) => [...notes] };

export const briefingOf = (card: Persona | undefined): TurnBriefing => {
    const omit = card?.briefing?.omit ?? [];
    if (omit.length === 0) {
        return FULL_BRIEFING;
    }
    const dropped = new Set(omit);
    const droppedTitles = new Set(omit.flatMap((id) => BRIEFING_NOTE_TITLES[id]));
    return {
        sends: (id) => !dropped.has(id),
        keep: (notes) => notes.filter((note) => !droppedTitles.has(note.title)),
    };
};

// The notes no card may drop, by the title constants at each one's own definition. Listed for the same reason as the
// map above: the editor tells the owner these six are always sent, and a reworded note would make that list wrong in a
// way nothing else would catch.
const FIXTURE_TITLES: ReadonlySet<string> = new Set([
    WORKTREE_NOTE_TITLE,
    PERSONA_NOTE_TITLE,
    MEMORY_NOTE_TITLE,
    GATED_CREDENTIALS_TITLE,
    UNATTENDED_ACCOUNTS_TITLE,
    LITERAL_SLASH_NOTE.title,
]);

// Every label the card editor shows, droppable or not, is the title the transcript shows for that note. Exported for
// the test that holds it; nothing at runtime needs it.
export const briefingLabelMismatches = (): string[] => [
    ...TURN_BRIEFING_NOTES.filter((note) => !BRIEFING_NOTE_TITLES[note.id].includes(note.label)).map((note) => note.id),
    ...TURN_BRIEFING_FIXTURES.filter((fixture) => !FIXTURE_TITLES.has(fixture.label)).map((fixture) => fixture.label),
];
