import { RESUME_NOTES, withResumeNote } from "@intentic/sandbox-contract";
import { describe, expect, it } from "vitest";
import { ERRANDS, errandOf, errandPrompt } from "./errands";

/* The classifier is the whole mechanism: an errand that stops reading as one goes back to opening a turn of
 * its own and pinning the app's prose over the user's question, silently and only after a reload, so what it
 * has to survive is pinned here rather than left to the one call site. */

const errand = ERRANDS.landConflict;
const user = (text: string) => ({ id: 1, role: `user`, text }) as const;

describe(`errandOf`, () => {
    it(`recognises a composed errand by the opening it was composed from`, () => {
        expect(errandOf(user(errandPrompt(errand, [`whatever this instance had to say`])))).toBe(errand);
    });

    // A turn the daemon restarted repeats its prompt behind a note explaining why (events.ts). It is the same
    // chore, still deferring to the same question, and nothing else on the hydrate path strips that note.
    it(`sees through the note a resumed turn carries`, () => {
        for (const note of Object.values(RESUME_NOTES)) {
            expect(errandOf(user(withResumeNote(errandPrompt(errand, [`blocked`]), note))), note).toBe(errand);
        }
    });

    it(`is not fooled by prose that merely mentions one, or by the agent quoting it back`, () => {
        expect(errandOf(user(`the land failed again — ${errand.opening}`))).toBeUndefined();
        expect(errandOf(user(`rebase onto main and resolve the conflicts`))).toBeUndefined();
        expect(errandOf({ id: 1, role: `assistant`, text: errand.opening })).toBeUndefined();
        expect(errandOf(user(``))).toBeUndefined();
    });
});

// Two errands sharing an opening would make the pair unresolvable, and the registry is where a new one is
// added, so the uniqueness it depends on is checked over whatever it currently holds, not over today's two.
it(`gives every errand an opening no other errand's prompt starts with`, () => {
    const openings = Object.values(ERRANDS).map((entry) => entry.opening);
    for (const opening of openings) {
        expect(openings.filter((other) => other.startsWith(opening) || opening.startsWith(other))).toEqual([opening]);
    }
});
