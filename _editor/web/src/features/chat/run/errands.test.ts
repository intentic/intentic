import { RESUME_NOTES, withResumeNote } from "@intentic/sandbox-contract";
import { describe, it, expect } from "bun:test";
import { errands, errandOf, errandPrompt } from "./errands";

/* Errand classification keeps app-generated prose out of user turns. */

const errand = errands().landConflict;
const user = (text: string) => ({ id: 1, role: `user`, text }) as const;

describe(`errandOf`, () => {
    it(`recognises a composed errand by the opening it was composed from`, () => {
        expect(errandOf(user(errandPrompt(errand, [`whatever this instance had to say`])))?.opening).toBe(errand.opening);
    });

    // A turn the daemon restarted repeats its prompt behind a note explaining why (events.ts). It is the same
    // chore, still deferring to the same question, and nothing else on the hydrate path strips that note.
    it(`sees through the note a resumed turn carries`, () => {
        for (const note of Object.values(RESUME_NOTES)) {
            expect(errandOf(user(withResumeNote(errandPrompt(errand, [`blocked`]), note)))?.opening, note).toBe(errand.opening);
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
    const openings = Object.values(errands()).map((entry) => entry.opening);
    for (const opening of openings) {
        expect(openings.filter((other) => other.startsWith(opening) || opening.startsWith(other))).toEqual([opening]);
    }
});
