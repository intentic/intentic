import { expect, test } from "vitest";
import { RESUME_NOTES, withResumeNote, withoutResumeNote } from "./events.js";

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
