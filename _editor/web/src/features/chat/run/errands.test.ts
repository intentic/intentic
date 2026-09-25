import { LAND_FIX_OPENING, landFixPrompt, RESUME_NOTES, VERIFY_NUDGE_OPENING, verifyNudgePrompt, withResumeNote } from "@intentic/sandbox-contract";
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

// The first prompt of a fresh conversation the DAEMON starts on a red main line (land-fix.ts), composed here the way the
// daemon composes it, so a reworded opening on either side fails rather than filing the brief as the user's words.
it(`recognises the brief a fresh fix-up is started with, through the contract's own reader`, () => {
    const brief = landFixPrompt([`\`pnpm verify\` in \`web\` failed on:`, `- web/src/pages/changelog.test.ts › lists every release`]);
    const found = errandOf(user(brief));
    expect(found?.opening).toBe(LAND_FIX_OPENING);
    expect(found?.label).toBe(errands().landFix.label);
    expect(found?.icon).toBe(`wrench`);
    expect(errandOf(user(withResumeNote(brief, Object.values(RESUME_NOTES)[0]!)))?.opening).toBe(LAND_FIX_OPENING);
});

// Nothing sends a verify nudge any more, but transcripts already hold them, and they must go on reading as the sandbox's.
it(`still recognises the retired verify nudge in older transcripts`, () => {
    expect(errandOf(user(verifyNudgePrompt([`This turn changed code and no check has passed since the last edit.`])))?.opening).toBe(VERIFY_NUDGE_OPENING);
});

// Two errands sharing an opening would make the pair unresolvable, and the registry is where a new one is
// added, so the uniqueness it depends on is checked over whatever it currently holds, not over today's two.
it(`gives every errand an opening no other errand's prompt starts with`, () => {
    const openings = Object.values(errands()).map((entry) => entry.opening);
    for (const opening of openings) {
        expect(openings.filter((other) => other.startsWith(opening) || opening.startsWith(other))).toEqual([opening]);
    }
});
