import { type Ref } from "vue";
import { definePreference } from "@intentic/ui/preference";

const STORAGE_KEY = `ui-changes-by-module`;

/* Whether the review lists read by MODULE (a package header over its files, the default) or by PATH (one
 * repo-relative path per row). An account preference (composables/preference.ts), mirroring useFileNesting,
 * and read by BOTH review surfaces, the workspace Changes panel and the fleet's agent review, because it is a
 * way of reading a change list rather than a property of either screen — or of either window showing one.
 *
 * On by default: "which part of the system did this touch" is the first question of a review, and the module
 * prefix is the repeated half of the path, the half a 270px sidebar truncates away. A repo with no manifests
 * to group by (a Rust/Python/Go tree, a bare docs repo) costs nothing for it being on: every path lands in the
 * one unclaimed bucket, which draws no header and keeps full paths (changeModules' moduleView and its `named`,
 * the rule both panels share), so those repos read exactly as they would with this off. */

const groupByModule: Ref<boolean> = definePreference<boolean>({
    key: STORAGE_KEY,
    read: (raw) => raw !== `off`,
    write: (value) => (value ? `on` : `off`),
});

export function useChangeGrouping() {
    return { groupByModule };
}
