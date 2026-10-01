import { RESUME_NOTES, resumeDisclosure, resumeNoticeRow, withResumeNote, withoutResumeNote } from "./resume.js";

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

test("a turn the door turned away discloses as its own notice, apart from the allowance's refusal", () => {
    const door = resumeDisclosure(withResumeNote("ship the parser", RESUME_NOTES.door));
    const refused = resumeDisclosure(withResumeNote("ship the parser", RESUME_NOTES.refused));
    expect(door).toEqual({ kind: "notice", text: expect.stringContaining("turned away"), reason: "door" });
    expect(door).not.toEqual(refused);
});

test("a prompt that is not a resume discloses nothing", () => {
    expect(resumeDisclosure("just a question")).toBeUndefined();
    expect(resumeDisclosure("")).toBeUndefined();
});

// A fresh session after an overflow is neither a carried session nor a switched account; it says which wall it was.
test("a re-run after the window overflowed discloses as its own notice", () => {
    expect(resumeDisclosure(withResumeNote("ship the parser", RESUME_NOTES.overflow))).toEqual({
        kind: "notice",
        text: "Sent again in a fresh session after the last one outgrew the model's context window.",
        reason: "overflow",
    });
});

// The row keeps the English line, and names the re-run so an app can say it in its reader's language.
test("a re-run's notice row names its reason beside its words", () => {
    const disclosure = resumeDisclosure(withResumeNote("ship the parser", RESUME_NOTES.restart));
    expect(disclosure?.kind === "notice" ? resumeNoticeRow(disclosure) : undefined).toEqual({
        role: "notice",
        text: "The sandbox came back, this turn picked up where it left off.",
        noticeCode: { code: "resumed", params: { reason: "restart" } },
    });
});

// A Continue on a turn the sandbox kept nothing of sends the note alone: no words of the person's to strip back out, and
// the row it records is the sandbox's line, never a message from them.
test("a carried-on turn's note stands alone, leaves no words, and records as a notice", () => {
    expect(withoutResumeNote(RESUME_NOTES.continued)).toBe("");
    expect(withResumeNote(RESUME_NOTES.continued, RESUME_NOTES.limit)).toBe(RESUME_NOTES.continued);
    const disclosure = resumeDisclosure(RESUME_NOTES.continued);
    expect(disclosure?.kind === "notice" ? resumeNoticeRow(disclosure) : undefined).toEqual({
        role: "notice",
        text: "Carried on from where the last turn stopped.",
        noticeCode: { code: "resumed", params: { reason: "continued" } },
    });
});
