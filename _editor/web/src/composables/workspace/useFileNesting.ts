import { type Ref } from "vue";
import { definePreference } from "@intentic/ui/preference";

const STORAGE_KEY = `ui-file-nesting`;

/* Owns the file-nesting toggle as an account preference (composables/preference.ts), mirroring useExplorerStyle,
 * so every window of the app reads the same tree. Deliberately binary: no per-pattern rules, when on, every
 * directory that holds a package.json folds its other files under it (see pages/workspace/fileNesting.ts).
 * Defaults to on. */

const fileNesting: Ref<boolean> = definePreference<boolean>({
    key: STORAGE_KEY,
    read: (raw) => raw !== `off`,
    write: (value) => (value ? `on` : `off`),
});

export function useFileNesting() {
    return { fileNesting };
}
