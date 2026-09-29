import type { Ref } from "vue";
import { definePreference } from "@intentic/ui/preference";
import { localFace } from "../../../app/environments/local";

const STORAGE_KEY = `ui-file-nesting`;

/* File nesting is an account preference shared by every window. */

// Unset, it folds a package's files under package.json in a sandbox, and leaves a folder on this computer as its file
// manager shows it (app/environments/local.ts). A choice the reader made wins either way, and the default is never
// written down, so a window of one kind cannot hand its default to the other.
const fileNesting: Ref<boolean> = definePreference<boolean>({
    key: STORAGE_KEY,
    read: (raw) => (raw === null ? localFace() === undefined : raw !== `off`),
    write: (value) => (value ? `on` : `off`),
});

export function useFileNesting() {
    return { fileNesting };
}
