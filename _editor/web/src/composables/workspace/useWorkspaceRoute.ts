import { computed, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useWorkspaceTabs } from "./useWorkspaceTabs";

/* Keeps the open FILE in the URL (`/workspace/src/foo.ts`) so a reload or a shared link reopens it, and the
 * browser back/forward walk the files. The useWorkspaceTabs singleton stays the source of truth — this projects
 * its active file tab onto the route and hydrates the singleton from the route (deep links, back/forward). Only
 * `file` tabs are addressable; a diff/plan/directory tab (or none) is bare `/workspace`. Called once from
 * whichever of WorkspaceDesktop/WorkspaceMobile is mounted (needs router context; the singleton openers stay
 * pure so they can fire from outside the Workspace subtree — QuickOpen, chat — without a router).
 *
 * vue-router splat gotcha: `route.params.path` reads as a string[] when set but "" when bare, and a WRITE must
 * pass an array (a string encodes "/" → %2F). */
export function useWorkspaceRoute(): void {
    const route = useRoute();
    const router = useRouter();
    const { activeTab, activeId, openFile } = useWorkspaceTabs();

    const urlPath = computed(() => {
        const path = route.params[`path`];
        // "" is the bare-/workspace sentinel; the optional splat is never truly absent, but indexed access widens it.
        return Array.isArray(path) ? path.join(`/`) : (path ?? ``);
    });
    const activeFilePath = computed(() => (activeTab.value?.kind === `file` ? activeTab.value.path : ``));

    // Reconcile once at mount: a deep link (URL names a file) wins; otherwise assert the singleton's open file
    // into the URL so navigating back into the Workspace keeps the last file shareable.
    if (urlPath.value !== ``) {
        if (urlPath.value !== activeFilePath.value) {
            openFile(urlPath.value);
        }
    } else if (activeFilePath.value !== ``) {
        void router.replace({ name: `workspace`, params: { path: activeFilePath.value.split(`/`) }, query: route.query });
    }

    // State → URL: any active-file change (open, tab select, close) reflects into the path; a non-file/empty tab
    // is bare `/workspace`. The equality guard stops the ping-pong with the URL → state watcher below.
    watch(activeFilePath, (path) => {
        if (path === urlPath.value) {
            return;
        }
        void router.push({ name: `workspace`, params: { path: path ? path.split(`/`) : [] }, query: route.query });
    });

    // URL → state: deep links and browser back/forward. Empty path deselects only a file tab, so a mobile `?diff=`
    // view (activeFilePath already "", guard returns first) is never clobbered.
    watch(urlPath, (path) => {
        if (path === activeFilePath.value) {
            return;
        }
        if (path === ``) {
            if (activeTab.value?.kind === `file`) {
                activeId.value = null;
            }
            return;
        }
        openFile(path);
    });
}
