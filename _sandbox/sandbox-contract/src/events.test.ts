import { expect, test } from "vitest";
import { RESUME_NOTES, resumeDisclosure, withResumeNote, withoutResumeNote } from "./events.js";

/* The resume note is a round trip across the wire: the daemon wraps a prompt to tell the model what interrupted
 * it, and the client unwraps the SAME prompt off an attach head to tell whether it already has that bubble. A
 * mismatch between the two halves fails silently and cosmetically — a paragraph of machine prose rendered as
 * something the user typed — which is exactly the kind of drift that stays broken. */
test("a resume note round-trips back to the user's own words", () => {
    for (const note of Object.values(RESUME_NOTES)) {
        expect(withoutResumeNote(withResumeNote("ship the parser", note))).toBe("ship the parser");
    }
});

// A prompt with blank lines of its own: only the note's own separator comes off, never the user's paragraphs.
test("stripping takes the note and nothing of the prompt", () => {
    const prompt = "step one\n\nstep two\n\nstep three";
    expect(withoutResumeNote(withResumeNote(prompt, RESUME_NOTES.outage))).toBe(prompt);
});

// An ordinary prompt passes through untouched, so every attach head can be handed through it.
test("a prompt that is not a resume is left alone", () => {
    expect(withoutResumeNote("just a question")).toBe("just a question");
    expect(withoutResumeNote("")).toBe("");
});

// Wrapping is idempotent: a resume that dies the same way again is re-recorded from its own input, and a second
// note stacked on the first would grow the prompt on every attempt.
test("wrapping an already-wrapped prompt adds nothing", () => {
    const once = withResumeNote("retry me", RESUME_NOTES.restart);
    expect(withResumeNote(once, RESUME_NOTES.restart)).toBe(once);
    expect(withResumeNote(once, RESUME_NOTES.auth)).toBe(once);
});

/* THE OTHER HALF OF THE ROUND TRIP: taking the note off is what keeps it out of the user's words, and this is
 * what puts it back on screen as something that happened instead. Every reader of a stored prompt asks the same
 * question here, so a note nobody could disclose is a note that silently reads as the user's own sentence. */
test("a re-run discloses as a notice, and the answered case as a note on the message", () => {
    for (const reason of ["auth", "outage", "restart"] as const) {
        const disclosure = resumeDisclosure(withResumeNote("ship the parser", RESUME_NOTES[reason]));
        expect(disclosure?.kind).toBe("notice");
    }
    // The answer is new words the user really did type, so nothing is dropped — the interruption rides them.
    const answered = resumeDisclosure(withResumeNote("option two", RESUME_NOTES.answered));
    expect(answered).toEqual({ kind: "note", note: { title: expect.any(String), text: RESUME_NOTES.answered } });
});

// Same guarantee withoutResumeNote gives: an ordinary prompt is not a resume of anything.
test("a prompt that is not a resume discloses nothing", () => {
    expect(resumeDisclosure("just a question")).toBeUndefined();
    expect(resumeDisclosure("")).toBeUndefined();
});
