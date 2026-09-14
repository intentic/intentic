import type { Ref } from "vue";
import { explorerStyles, type ExplorerStyle } from "../icons/explorerStyle.js";
import { definePreference } from "./preference.js";

const STORAGE_KEY = `ui-explorer-style`;

/* Owns the active file-tree setup as an account preference (composables/preference.ts), mirroring useTheme, so every window of the app agrees on it. */

const isExplorerStyle = (value: unknown): value is ExplorerStyle => explorerStyles.includes(value as ExplorerStyle);

const explorerStyle: Ref<ExplorerStyle> = definePreference<ExplorerStyle>({
    key: STORAGE_KEY,
    read: (raw) => (isExplorerStyle(raw) ? raw : `colorful`),
    write: (value) => value,
});

export function useExplorerStyle() {
    return { explorerStyle, explorerStyles };
}
