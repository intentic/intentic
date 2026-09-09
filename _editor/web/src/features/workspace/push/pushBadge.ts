import type { ViewBadge } from "@intentic/extension-api";
import type { PushQuestion, PushStage, StandingVerdict } from "./usePushFlow";

// What a push in flight says on the rail's Workspace tile and the phone's Review tab, from one place so the
// two can't drift. Outranks the tile's standing counts, since this is happening now (or a decision owed), not
// a static fact about the tree. A glyph, never a count: the amount lives in the tooltip.
export const pushBadge = (stage: PushStage | undefined, question: PushQuestion | undefined, held?: StandingVerdict): ViewBadge | undefined => {
    // A decision the user owes; `danger` is spent here since a push they asked for is standing unsent.
    if (question !== undefined) {
        return { mark: `exclamation-triangle`, tone: `danger`, tooltip: `${question.title}, your push is waiting on you` };
    }
    /* THE SAME DECISION WITH THE CARD CLOSED. Closing it moved the question off the screen; it did not answer it, and
     * a tile that goes quiet at that moment is the app agreeing the failure is over. Same glyph, since it is the same
     * fact, in `warning`: it is no longer interrupting anyone, and the panel is where the whole of it is. */
    if (held !== undefined) {
        return { mark: `exclamation-triangle`, tone: `warning`, tooltip: `${held.question.title}. Your push is still waiting on you` };
    }
    // `wave-pulse`, not a spinner: the rail draws a static glyph, and one that doesn't turn reads as stuck.
    if (stage === `checking`) {
        return { mark: `wave-pulse`, tooltip: `Checks are running before your push` };
    }
    if (stage === `pushing`) {
        return { mark: `arrow-up-right`, tooltip: `Sending your commits` };
    }
    return undefined;
};
