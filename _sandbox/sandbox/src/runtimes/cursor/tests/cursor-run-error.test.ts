import { cursorRunErrorFrame } from "../cursor-agent.js";

/* Cursor reports a spent plan as a run that ENDED in error, not as a thrown RateLimitError — the SDK keeps that class
   for an HTTP 429. The frame went out uncoded, so classify-failure.ts filed no refusal and no observed limit, the child
   took no hold and no re-run, and `agents providers` still read "not metered" two days later. Seven subagent turns were
   refused for a spent Cursor plan with not one line written down (2026-10-13). This suite is the guard. */

// Cursor's own sentence, verbatim from the daemon log of the turns that were lost.
const OUT_OF_USAGE =
    `Increase limits for faster responses You're out of usage. Switch to Auto or Composer 2.5, or ask your admin to increase your limit to continue.`;

test("codes Cursor's own out-of-usage sentence as a spent allowance", () => {
    expect(cursorRunErrorFrame({ message: OUT_OF_USAGE })).toEqual({ kind: "error", message: OUT_OF_USAGE, code: "rate_limit" });
});

// The code is the half that survives a reworded message, and it is what crosses from a runtime in a mount namespace.
test("codes a spent allowance from the vendor's code alone, whatever the sentence says", () => {
    expect(cursorRunErrorFrame({ message: `The agent stopped.`, code: "resource_exhausted" })).toMatchObject({ code: "rate_limit" });
    expect(cursorRunErrorFrame({ message: `The agent stopped.`, code: "quota_exceeded" })).toMatchObject({ code: "rate_limit" });
});

// An unknown vendor code must not become a daemon code: the message carries it to the log, and the frame stays bare so
// nothing books a re-run past a wall it has not recognised.
test("leaves any other failure uncoded rather than guessing at one", () => {
    expect(cursorRunErrorFrame({ message: `The repository could not be cloned.`, code: "internal" })).toEqual({
        kind: "error",
        message: `The repository could not be cloned.`,
    });
});

test("says something rather than nothing when the run reports no error at all", () => {
    expect(cursorRunErrorFrame(undefined)).toEqual({ kind: "error", message: "The Cursor turn failed." });
    expect(cursorRunErrorFrame({ message: `` })).toEqual({ kind: "error", message: "The Cursor turn failed." });
});
