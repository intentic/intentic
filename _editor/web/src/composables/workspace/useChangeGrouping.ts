import { ref, watch, type Ref } from "vue";

const STORAGE_KEY = `ui-changes-by-module`;

/* Whether the review lists read by MODULE (a package header over its files, the default) or by PATH (one
 * repo-relative path per row). A module-level singleton persisted to localStorage, mirroring useFileNesting,
 * and read by BOTH review surfaces, the workspace Changes panel and the fleet's agent review, because it is a
 * way of reading a change list rather than a property of either screen.
 *
 * On by default: "which part of the system did this touch" is the first question of a review, and the module
 * prefix is the repeated half of the path, the half a 270px sidebar truncates away. A repo with no manifests
 * to group by (a Rust/Python/Go tree, a bare docs repo) costs nothing for it being on: every path lands in the
 * one unclaimed bucket, which draws no header and keeps full paths (changeModules' moduleView and its `named`,
 * the rule both panels share), so those repos read exactly as they would with this off. */

const read = (): boolean => {
    try {
        return localStorage.getItem(STORAGE_KEY) !== `off`;
    } catch {
        // Storage may be unavailable (private mode); fall back to the default.
        return true;
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
