import { useDevice } from "@intentic/ui";
import { computed, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useWorkspaceTabs } from "../tabs/useWorkspaceTabs";
import { workspaceAgent } from "./workspaceScope";

// Two-way syncs the open file (and `?agent` scope) between the URL and the tabs singleton, so reload and
// back/forward work; only file tabs are addressable. `route.params.path` is string[] or "" when bare; writes need an
// array.
export function useWorkspaceRoute(): void {
    const route = useRoute();
    const router = useRouter();
    const { activeTab, activeId, openFile } = useWorkspaceTabs();

    // URL <-> scope; the route wins at mount, but a scope set from outside (e.g. chat) writes back into the URL.
    const urlAgent = computed(() => {
        const agent = route.query[`agent`];
        return typeof agent === `string` && agent !== `` ? agent : undefined;
    });
    workspaceAgent.value = urlAgent.value;
    watch(urlAgent, (agent) => {
        workspaceAgent.value = agent;
    });
    watch(workspaceAgent, (agent) => {
        if (agent === urlAgent.value) {
            return;
        }
        const { agent: _dropped, ...rest } = route.query;
        void router.replace({ query: agent === undefined ? rest : { ...rest, agent } });
    });

    const urlPath = computed(() => {
        const path = route.params[`path`];
        // "" is the bare-/workspace sentinel; the optional splat is never absent, but indexed access widens it.
        return Array.isArray(path) ? path.join(`/`) : (path ?? ``);
    });
    const activeFilePath = computed(() => (activeTab.value?.kind === `file` ? activeTab.value.path : ``));

    // Reconcile once at mount: a deep link wins; otherwise the singleton's open file is asserted into the URL.
    // Not on a phone, where the URL is the state: a bare /workspace there is the list or the Review tab's Changes
    // panel, and a file tab restored from storage on a cold load would put the viewer over whichever was asked for.
    const { mobile } = useDevice();
    if (urlPath.value !== ``) {
        if (urlPath.value !== activeFilePath.value) {
            openFile(urlPath.value);
        }
    } else if (activeFilePath.value !== ``) {
        if (mobile.value) {
            activeId.value = null;
        } else {
            void router.replace({ name: `workspace`, params: { path: activeFilePath.value.split(`/`) }, query: route.query });
        }
    }

    // State -> URL: an active-file change reflects into the path; guards against ping-pong with the watcher below.
    watch(activeFilePath, (path) => {
        if (path === urlPath.value) {
            return;
        }
        void router.push({ name: `workspace`, params: { path: path ? path.split(`/`) : [] }, query: route.query });
    });

    // URL -> state: deep links, back/forward. Empty path deselects a file tab only; a mobile `?diff=` view survives.
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
