import type { Ref } from "vue";
import { definePreference } from "@intentic/ui/preference";

const STORAGE_KEY = `ui-file-nesting`;

/* File nesting is an account preference shared by every window. */

const fileNesting: Ref<boolean> = definePreference<boolean>({
    key: STORAGE_KEY,
    read: (raw) => raw !== `off`,
    write: (value) => (value ? `on` : `off`),
});

export function useFileNesting() {
    return { fileNesting };
}
