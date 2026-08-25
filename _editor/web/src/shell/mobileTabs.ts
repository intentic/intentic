import type { ViewBadge } from "@intentic/extension-api";
import { computed, type ComputedRef } from "vue";
import { useCapabilities } from "../composables/extensions/useCapabilities";
import { usePanels } from "../composables/extensions/usePanels";
import { activationBadge, detectActivations, DRAFTS_VIEW_ID, extensionPath } from "../core-views/registry";

/* WHERE THE MOBILE TAB BAR POINTS, as one statement two components read.
 *
 * MobileTabBar draws the four tabs; ShellMobile has to know the same four ADDRESSES, because a route that is
 * one of them is already reachable in one thumb press and must not also grow a back arrow (see pageBack.ts).
 * Three of the four are constants and the fourth is not: Review is the drafts extension's tile when the pack is
 * on and the workspace's own Changes panel when it is off, so "is this route a tab" cannot be answered by a
 * literal list. Hence one module: the tile is resolved once, and the bar and the shell cannot drift about where
 * Review lives — which is the exact failure this bar already had once, when the tab matched a package id
 * against a list of view ids and never reached the queue it is named for. */

export interface DraftsTile {
    readonly to: string;
    readonly badge: ViewBadge | undefined;
}

/** The drafts extension's activation, when the pack is on: the Review tab's target and its owed-count. */
export function useDraftsTile(): ComputedRef<DraftsTile | undefined> {
    const { panels } = usePanels();
    const { capabilities } = useCapabilities();
    return computed(() => {
        const active = detectActivations(panels.value, capabilities.value).find(({ extension }) => extension.id === DRAFTS_VIEW_ID);
        return active === undefined ? undefined : { to: extensionPath(active.extension, active.activation), badge: activationBadge(active) };
    });
}

/* The four tab destinations as PATHS — no query, because the question this answers is "is the reader on a tab's
 * own screen", and `/workspace?panel=changes` is the Files tab's path with a panel chosen on it. Both workspace
 * tabs collapse to `/workspace` here, which is right: either way the tab bar is the way out. */
export function useTabRootPaths(): ComputedRef<readonly string[]> {
    const draftsTile = useDraftsTile();
    return computed(() => {
        const review = draftsTile.value?.to ?? `/workspace`;
        return [`/agents`, `/workspace`, `/menu`, review.split(`?`)[0] ?? review];
    });
}

/** Is `path` a tab's own screen, or a drill-down inside one (a file, an agent) that owns its own way back. */
export const onTabRoot = (path: string, roots: readonly string[]): boolean => roots.some((root) => path === root || path.startsWith(`${root}/`));
