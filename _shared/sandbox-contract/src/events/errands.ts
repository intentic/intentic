import type { TurnErrand } from "../schemas/speaker.js";
import type { TranscriptRow } from "./transcript.js";
import { isLandBreakage, isLandFix } from "./land-breakage.js";
import { LAND_CONFLICT_OPENING } from "./land-conflict.js";
import { withoutResumeNote } from "./resume.js";
import { isVerifyNudge } from "./verify-nudge.js";

// Which errand a composed prompt is, read the old way: by its opening paragraph, for the rows and turns written before
// they carried `errand`. The openings are anchored on here, so each must stay byte-identical forever. A prompt the
// daemon restarted carries its resume note first, so it is read past.
export const errandOfPrompt = (prompt: string): TurnErrand | undefined => {
    const text = withoutResumeNote(prompt.trim());
    if (text.startsWith(LAND_CONFLICT_OPENING)) {
        return "land-conflict";
    }
    if (isVerifyNudge(text)) {
        return "verify-nudge";
    }
    if (isLandBreakage(text)) {
        return "land-breakage";
    }
    return isLandFix(text) ? "land-fix" : undefined;
};

/** A message row's errand: what the row says, else what its opening names; none for anything but a message. */
export const errandOfRow = (row: Pick<TranscriptRow, "role" | "text" | "errand">): TurnErrand | undefined =>
    row.role !== "user" ? undefined : (row.errand ?? errandOfPrompt(row.text));
