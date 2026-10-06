import type { ViewBadge } from "@intentic/extension-api";
import { computed, type ComputedRef } from "vue";
import { useCapabilities } from "../features/capabilities/connect/useCapabilities";
import { usePanels } from "../features/extensions/usePanels";
import { useInbox } from "../features/needs/inbox/useInbox";
import { APPROVALS_VIEW_ID, detectActivations } from "../workbench/views/registry";
import { parseRoot, type TabRoot } from "../lib/routes/tabRoots";

// The four tab destinations MobileTabBar and ShellMobile both need. Agents and Menu are constants; Chat is the active
// conversation's own screen (tabRoots.ts); Review is the Needs you inbox when the approvals pack is on, else the
// workspace's own Changes panel, so it can't be a literal list. Resolved once here so the bar and shell can't drift.

export interface InboxTile {
    readonly to: string;
    readonly badge: ViewBadge | undefined;
}

export const INBOX_PATH = `/needs`;

// The Review tab's badge speaks for the page the tab opens and nothing else: the inbox's one count when it opens the
// inbox, else what the Changes panel it falls back to shows. Uncommitted files once rode on the approvals count, so
// every land raised a number the Approvals page then said was "Nothing waiting".
export const reviewBadgeFor = (inbox: InboxTile | undefined, changes: ViewBadge | undefined): ViewBadge | undefined =>
    inbox === undefined ? changes : inbox.badge;

// Review opened the approvals queue while that pack was on. The queue's decisions are asks in Needs you now, beside
// everything else waiting on a person, so the tab opens there and carries its count; the queue itself (scheduled,
// going ahead, done) is a Menu row like any other section. Off, Review stays the Changes panel it always was.
export function useInboxTile(): ComputedRef<InboxTile | undefined> {
    const { panels } = usePanels();
    const { capabilities } = useCapabilities();
    const { badge } = useInbox();
    return computed(() =>
        detectActivations(panels.value, capabilities.value).some(({ extension }) => extension.id === APPROVALS_VIEW_ID)
            ? { to: INBOX_PATH, badge: badge.value }
            : undefined,
    );
}

// The tab destinations as roots: Agents covers the conversation screens under it (the Chat tab's), so neither draws
// the shell's back arrow — they carry their own.
export function useTabRoots(): ComputedRef<readonly TabRoot[]> {
    const inboxTile = useInboxTile();
    return computed(() => [{ path: `/agents` }, { path: `/menu` }, parseRoot(inboxTile.value?.to ?? `/workspace?panel=changes`)]);
}
