import type { TranscriptRow } from "@intentic/sandbox-contract/events/transcript";
import { TURN_CHECKS_SOURCE } from "../turn-checks.js";
import { closingOf } from "./turn-closing.js";

/* What a child's report carries. 2026-10-17: six children answered the end-of-turn checks (findings that were their
   siblings' work), and the answer reached their parent as the whole report. */

const said = (text: string): TranscriptRow => ({ role: "assistant", text });
const checked: TranscriptRow = { role: "notice", text: "checks said back", agentNotice: { level: "info", source: TURN_CHECKS_SOURCE } };

test("a turn the checks were said back to reports what it ended on first, then its answer to them", () => {
    expect(closingOf([said("WS3 done: three files, tests pass."), checked, said("None of those findings are mine.")])).toBe(
        "WS3 done: three files, tests pass.\n\nOn the end-of-turn checks: None of those findings are mine.",
    );
});

test("a turn nothing was said back to reports its last prose, as before", () => {
    expect(closingOf([said("first"), said("WS3 done.")])).toBe("WS3 done.");
    expect(closingOf([])).toBe("");
});

test("an answer missing on either side of the notice leaves the side there is", () => {
    expect(closingOf([said("WS3 done."), checked])).toBe("WS3 done.");
    expect(closingOf([checked, said("fixed two of them")])).toBe("fixed two of them");
});
