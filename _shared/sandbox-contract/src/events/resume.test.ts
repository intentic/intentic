import { expect, test } from "vitest";
import { RESUME_NOTES, resumeDisclosure, withResumeNote, withoutResumeNote } from "./resume.js";

// Wrapping then unwrapping a resume note must return the exact original prompt; a mismatch leaks machine narration into
// the user's own words on screen.
test("a resume note round-trips back to the user's own words", () => {
    for (const note of Object.values(RESUME_NOTES)) {
        expect(withoutResumeNote(withResumeNote("ship the parser", note))).toBe("ship the parser");
    }
});

// The prompt itself contains blank lines, to prove only the note's own separator is stripped.
test("stripping takes the note and nothing of the prompt", () => {
    const prompt = "step one\n\nstep two\n\nstep three";
    expect(withoutResumeNote(withResumeNote(prompt, RESUME_NOTES.outage))).toBe(prompt);
});

test("a prompt that is not a resume is left alone", () => {
    expect(withoutResumeNote("just a question")).toBe("just a question");
    expect(withoutResumeNote("")).toBe("");
});

test("wrapping an already-wrapped prompt adds nothing", () => {
    const once = withResumeNote("retry me", RESUME_NOTES.restart);
    expect(withResumeNote(once, RESUME_NOTES.restart)).toBe(once);
    expect(withResumeNote(once, RESUME_NOTES.auth)).toBe(once);
});

test("a re-run discloses as a notice, and the answered case as a note on the message", () => {
    for (const reason of ["auth", "outage", "restart"] as const) {
        const disclosure = resumeDisclosure(withResumeNote("ship the parser", RESUME_NOTES[reason]));
        expect(disclosure?.kind).toBe("notice");
    }
    const answered = resumeDisclosure(withResumeNote("option two", RESUME_NOTES.answered));
    expect(answered).toEqual({ kind: "note", note: { title: expect.any(String), text: RESUME_NOTES.answered } });
});

test("the spent-allowance notes do not disclose as each other", () => {
    const lines = (["limit", "switched", "refused"] as const).map((reason) => {
        const disclosure = resumeDisclosure(withResumeNote("ship the parser", RESUME_NOTES[reason]));
        expect(disclosure?.kind).toBe("notice");
        return disclosure?.kind === "notice" ? disclosure.text : reason;
    });
    expect(new Set(lines).size).toBe(3);
});

test("a prompt that is not a resume discloses nothing", () => {
    expect(resumeDisclosure("just a question")).toBeUndefined();
    expect(resumeDisclosure("")).toBeUndefined();
});
