import type { ViewBadge } from "@intentic/extension-api";
import { computed, type ComputedRef } from "vue";
import { useCapabilities } from "../features/capabilities/connect/useCapabilities";
import { usePanels } from "../features/extensions/usePanels";
import { activationBadge, APPROVALS_VIEW_ID, detectActivations, extensionPath } from "../core-views/registry";

// The four tab destinations MobileTabBar and ShellMobile both need. Three are constants; Review is the approvals
// extension's tile when that pack is on, else the workspace's own Changes panel, so it can't be a literal list.
// Resolved once here so the bar and shell can't drift on where Review lives.

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

// The four tab destinations as paths, no query: this answers whether the reader is on a tab's own screen, and
// both workspace tabs collapse to `/workspace`.
export function useTabRootPaths(): ComputedRef<readonly string[]> {
    const approvalsTile = useApprovalsTile();
    return computed(() => {
        const review = approvalsTile.value?.to ?? `/workspace`;
        return [`/agents`, `/workspace`, `/menu`, review.split(`?`)[0] ?? review];
    });
}

/** Is `path` a tab's own screen, or a drill-down inside one (a file, an agent) that owns its own way back. */
export const onTabRoot = (path: string, roots: readonly string[]): boolean => roots.some((root) => path === root || path.startsWith(`${root}/`));
