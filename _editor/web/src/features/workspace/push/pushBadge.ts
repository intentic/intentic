import type { ViewBadge } from "@intentic/extension-api";
import type { PushQuestion, StandingVerdict } from "./usePushFlow";
import { t } from "@intentic/ui/i18n";

// What a push in flight says on the rail's Workspace tile and the phone's Review tab, from one place so the
// two can't drift. Outranks the tile's standing counts, since this is happening now (or a decision owed), not
// a static fact about the tree. A glyph, never a count: the amount lives in the tooltip.
export const pushBadge = (running: boolean, question: PushQuestion | undefined, held?: StandingVerdict): ViewBadge | undefined => {
    // A decision the user owes; `danger` is spent here since a push they asked for is standing unsent.
    if (question !== undefined) {
        return { mark: `exclamation-triangle`, tone: `danger`, tooltip: t(`workspace.pushBadge.pushWaitingOn`, { title: question.title }) };
    }
    /* THE SAME DECISION WITH THE CARD CLOSED. Closing it moved the question off the screen; it did not answer it,. */
    if (held !== undefined) {
        return { mark: `exclamation-triangle`, tone: `warning`, tooltip: `${held.question.title}. Your push is still waiting on you` };
    }
    if (running) {
        return { mark: `arrow-up-right`, tooltip: t(`workspace.pushBadge.sendingCommits`) };
    }
    return undefined;
};
