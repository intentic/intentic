import { createHash } from "node:crypto";
import type { TurnNote } from "@intentic/sandbox-contract/events/transcript";
import type { ConversationActors } from "../../conversations/actor/conversation-actors.js";
import type { Holding } from "../../conversations/actor/conversation-holdings.js";
import { SURROUNDINGS_CLEARED, SURROUNDINGS_TITLE, type SurroundingsFacts, surroundingsText } from "./guidance.js";

/* THE "CONNECTED RIGHT NOW" NOTE, SAID WHEN IT CHANGED.

   Under a stable prompt (decide/experiments.ts `stablePrompt`) the guidance paragraphs whose condition moves between
   turns leave the system block (guidance.ts `volatile`). They ride the turn's message instead, and only when what they
   would say differs from what this conversation's session was last told: said every turn, each copy would stay in the
   history and be read again by every later call. What was said is held per conversation, in memory: a restart forgets
   it, and the next turn says it again, which costs one note. A fresh session or one the CLI just compacted has been told
   nothing it still holds, so it is told again too. */

type Actors = Pick<ConversationActors, "holdings">;

// A digest of the last note this conversation's session was sent under the heading; NOTHING_HOLDS once it was told
// that nothing does. Absent: never told anything, or told before this daemon started.
const SAID: Holding<string> = { name: "surroundings said" };
const NOTHING_HOLDS = "nothing";

const digestOf = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 16);

export interface SurroundingsSession {
    // The session starts here (no resume), or the CLI compacted it since the last turn: nothing said earlier is held.
    readonly fresh: boolean;
}

/**
 * The note this turn owes, or undefined when its session already holds what it would say. A turn with nothing to say
 * still owes the cleared note when its session was last told something that no longer holds.
 */
export const surroundingsNote = (
    actors: Actors,
    conversationId: string | undefined,
    session: SurroundingsSession,
    facts: SurroundingsFacts,
): TurnNote | undefined => {
    const text = surroundingsText(facts);
    const said = session.fresh || conversationId === undefined ? undefined : actors.holdings(SAID).get(conversationId);
    if (text === undefined) {
        return said === undefined || said === NOTHING_HOLDS ? undefined : { title: SURROUNDINGS_TITLE, text: SURROUNDINGS_CLEARED };
    }
    return said === digestOf(text) ? undefined : { title: SURROUNDINGS_TITLE, text };
};

/**
 * Files what the turn is about to be sent, once nothing can stop it going: the note it carries, or, for a fresh session
 * that carries none, that it was told nothing. A turn that carries no note on a session it resumes leaves the record as
 * it was, since that session still holds the last one.
 */
export const recordSurroundingsSaid = (
    actors: Actors,
    conversationId: string | undefined,
    sent: { readonly notes?: readonly TurnNote[] | undefined; readonly fresh: boolean },
): void => {
    if (conversationId === undefined) {
        return;
    }
    const note = sent.notes?.find((candidate) => candidate.title === SURROUNDINGS_TITLE);
    if (note !== undefined) {
        actors.holdings(SAID).hold(conversationId, conversationId, note.text === SURROUNDINGS_CLEARED ? NOTHING_HOLDS : digestOf(note.text));
    } else if (sent.fresh) {
        actors.holdings(SAID).hold(conversationId, conversationId, NOTHING_HOLDS);
    }
};
