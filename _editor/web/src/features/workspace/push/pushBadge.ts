import type { ViewBadge } from "@intentic/extension-api";
import type { PushQuestion, PushStage } from "./usePushFlow";

// What a push in flight says on the rail's Workspace tile and the phone's Review tab, from one place so the
// two can't drift. Outranks the tile's standing counts, since this is happening now (or a decision owed), not
// a static fact about the tree. A glyph, never a count: the amount lives in the tooltip.
export const pushBadge = (stage: PushStage | undefined, question: PushQuestion | undefined): ViewBadge | undefined => {
    // A decision the user owes; `danger` is spent here since a push they asked for is standing unsent.
    if (question !== undefined) {
        return { mark: `exclamation-triangle`, tone: `danger`, tooltip: `${question.title}, your push is waiting on you` };
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
