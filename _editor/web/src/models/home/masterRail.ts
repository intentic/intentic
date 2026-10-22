import { ref, watch } from "vue";
import { useRoute } from "vue-router";
import { masterRailAfter } from "../../lib/routes/home";

// Whether the desktop shell is in the master view: on /home, and on the person's own pages opened from there
// (lib/routes/home.ts masterRailAfter), until a page of a sandbox gives the shell back. The rail wears the sandboxes, and
// no chat column is docked beside, since the master view's one chat is its page. One reading for every surface that asks.
// allow(module-state): one shell per window, and the master view is a property of that window
export const masterRail = ref(false);

/** Follows the route; called once, by the desktop shell. */
export function followMasterRail(): void {
    const route = useRoute();
    watch(
        () => route.path,
        (path) => {
            masterRail.value = masterRailAfter(masterRail.value, path);
        },
        { immediate: true },
    );
}
