import type { ViewBadge } from "@intentic/extension-api";
import { computed, type ComputedRef } from "vue";
import { useCapabilities } from "../features/capabilities/connect/useCapabilities";
import { usePanels } from "../features/extensions/usePanels";
import { activationBadge, APPROVALS_VIEW_ID, detectActivations, extensionPath } from "../workbench/views/registry";
import { parseRoot, type TabRoot } from "../lib/routes/tabRoots";

// The four tab destinations MobileTabBar and ShellMobile both need. Agents and Menu are constants; Chat is the active
// conversation's own screen (tabRoots.ts); Review is the Approvals queue when that pack is on, else the workspace's own
// Changes panel, so it can't be a literal list. Resolved once here so the bar and shell can't drift.

export interface ReviewTile {
    readonly to: string;
    readonly badge: ViewBadge | undefined;
}

// The Review tab's badge speaks for the page the tab opens and nothing else: the queue's own count when it opens the
// queue, else what the Changes panel it falls back to shows. Uncommitted files once rode on the approvals count, so
// every land raised a number the Approvals page then said was "Nothing waiting".
export const reviewBadgeFor = (queue: ReviewTile | undefined, changes: ViewBadge | undefined): ViewBadge | undefined =>
    queue === undefined ? changes : queue.badge;

// Review opens the Approvals queue while that pack is on, wearing the badge its desktop tile wears. From 2026-10-04 to
// 2026-10-12 it opened the Needs you inbox instead; that inbox left the editor, and what an agent waits on is the
// Agents tab's count. Off, Review stays the Changes panel it always was.
export function useReviewTile(): ComputedRef<ReviewTile | undefined> {
    const { panels } = usePanels();
    const { capabilities } = useCapabilities();
    return computed(() => {
        const approvals = detectActivations(panels.value, capabilities.value).find(({ extension }) => extension.id === APPROVALS_VIEW_ID);
        return approvals === undefined ? undefined : { to: extensionPath(approvals.extension, approvals.activation), badge: activationBadge(approvals) };
    });
}

// The tab destinations as roots: Agents covers the conversation screens under it (the Chat tab's), so neither draws
// the shell's back arrow — they carry their own.
export function useTabRoots(): ComputedRef<readonly TabRoot[]> {
    const reviewTile = useReviewTile();
    return computed(() => [{ path: `/agents` }, { path: `/menu` }, parseRoot(reviewTile.value?.to ?? `/workspace?panel=changes`)]);
}
