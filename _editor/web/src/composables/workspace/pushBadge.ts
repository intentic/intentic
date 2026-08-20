import type { ViewBadge } from "@intentic/extension-api";
import type { PushQuestion, PushStage } from "./usePushFlow";

/* WHAT A PUSH IN FLIGHT SAYS ON A TILE, the rail's Workspace tile and the phone's Review tab, from one place
 * so the two cannot drift into two vocabularies for one fact (the same rule outgoingWork.ts holds).
 *
 * It is the thread back. The push was started in a panel the user then left, deliberately, so from every other
 * view in the app this glyph is the only thing that knows a suite is running, and the only way back to it. That
 * is also why it outranks the tile's standing counts: uncommitted changes are a fact about the tree that will
 * still be true in an hour, while this is a thing happening now, or a decision already owed.
 *
 * A GLYPH, NEVER A COUNT. There is one push flow at a time and one click either way; the amount lives in the
 * tooltip, which the host renders after the view's own name ("Workspace · Checks failed…"). */
export const pushBadge = (stage: PushStage | undefined, question: PushQuestion | undefined): ViewBadge | undefined => {
    // A decision the user owes. `danger` is spent here, sparingly, per ViewBadge, because a push the user
    // asked for is standing unsent, and the tile is the only thing saying so once the notice has been dismissed.
    if (question !== undefined) {
        return { mark: `exclamation-triangle`, tone: `danger`, tooltip: `${question.title} — your push is waiting on you` };
    }
    // `wave-pulse` rather than a spinner: the rail draws a mark as a static glyph, and a spinner that does not
    // turn reads as something stuck. This one depicts a live thing without pretending to animate.
    if (stage === `checking`) {
        return { mark: `wave-pulse`, tooltip: `Checks are running before your push` };
    }
    if (stage === `pushing`) {
        return { mark: `arrow-up-right`, tooltip: `Sending your commits` };
    }
    return undefined;
};
