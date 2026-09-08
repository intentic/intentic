import type { Ref } from "vue";
import { definePreference } from "@intentic/ui/preference";

const STORAGE_KEY = `ui-changes-by-module`;

// Whether review lists group by module (default) or by plain path; shared by both review surfaces as a way of
// reading a change list, not a property of either screen. A repo with no manifests still reads the same either
// way — its paths land in one unnamed bucket (changeModules' `named` rule).

const groupByModule: Ref<boolean> = definePreference<boolean>({
    key: STORAGE_KEY,
    read: (raw) => raw !== `off`,
    write: (value) => (value ? `on` : `off`),
});

export function useChangeGrouping() {
    return { groupByModule };
}
