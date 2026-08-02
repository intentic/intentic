import { ref, watch, type Ref } from "vue";

const STORAGE_KEY = `ui-changes-by-module`;

/* Whether the review lists read by MODULE (a package header over its files) or by PATH (one repo-relative path
 * per row, the default). A module-level singleton persisted to localStorage, mirroring useFileNesting — and
 * read by BOTH review surfaces, the workspace Changes panel and the fleet's agent review, because it is a way
 * of reading a change list rather than a property of either screen.
 *
 * Off by default: paths are what a change list has always been, and the module view is a deliberate way of
 * looking that the panel's own control offers where its effect is visible (Settings ▸ Appearance mirrors it,
 * the way the explorer's toggles do). */

const read = (): boolean => {
    try {
        return localStorage.getItem(STORAGE_KEY) === `on`;
    } catch {
        // Storage may be unavailable (private mode); fall back to the default.
        return false;
    }
};

const groupByModule: Ref<boolean> = ref(read());

// Persist every change (including direct writes from the Settings toggle), so no page needs a setter.
watch(groupByModule, (value) => {
    try {
        localStorage.setItem(STORAGE_KEY, value ? `on` : `off`);
    } catch {
        // Storage may be unavailable (private mode); the in-memory ref still holds.
    }
});

export function useChangeGrouping() {
    return { groupByModule };
}
