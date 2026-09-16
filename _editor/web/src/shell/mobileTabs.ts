import type { ViewBadge } from "@intentic/extension-api";
import { computed, type ComputedRef } from "vue";
import { useCapabilities } from "../features/capabilities/connect/useCapabilities";
import { usePanels } from "../features/extensions/usePanels";
import { activationBadge, APPROVALS_VIEW_ID, detectActivations, extensionPath } from "../core-views/registry";
import { parseRoot, type TabRoot } from "./tabRoots";

// The four tab destinations MobileTabBar and ShellMobile both need. Agents and Menu are constants; Chat is the active
// conversation's own screen (tabRoots.ts); Review is the approvals extension's tile when that pack is on, else the
// workspace's own Changes panel, so it can't be a literal list. Resolved once here so the bar and shell can't drift.

export interface ApprovalsTile {
    readonly to: string;
    readonly badge: ViewBadge | undefined;
}

/** The approvals extension's activation, when the pack is on: the Review tab's target and its owed-count. */
export function useApprovalsTile(): ComputedRef<ApprovalsTile | undefined> {
    const { panels } = usePanels();
    const { capabilities } = useCapabilities();
    return computed(() => {
        const active = detectActivations(panels.value, capabilities.value).find(({ extension }) => extension.id === APPROVALS_VIEW_ID);
        return active === undefined ? undefined : { to: extensionPath(active.extension, active.activation), badge: activationBadge(active) };
    });
}

// The tab destinations as roots: Agents covers the conversation screens under it (the Chat tab's), so neither draws
// the shell's back arrow — they carry their own.
export function useTabRoots(): ComputedRef<readonly TabRoot[]> {
    const approvalsTile = useApprovalsTile();
    return computed(() => [{ path: `/agents` }, { path: `/menu` }, parseRoot(approvalsTile.value?.to ?? `/workspace?panel=changes`)]);
}
