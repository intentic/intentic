import { ref, watch, type Ref } from "vue";
import { explorerStyles, type ExplorerStyle } from "../icons/explorerStyle.js";

const STORAGE_KEY = `ui-explorer-style`;

/* Owns the active file-tree setup as a module-level singleton, mirroring useIconSet. Drives no <html>
 * attribute — the workspace tree reads this ref directly, so switching setups repaints every row
 * reactively. Persisted to localStorage; reads fall back to the default until a choice is stored. */

const isExplorerStyle = (value: unknown): value is ExplorerStyle => explorerStyles.includes(value as ExplorerStyle);

const read = (): ExplorerStyle => {
    try {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (isExplorerStyle(stored)) {
            return stored;
        }
    } catch {
        // Storage may be unavailable (private mode); fall back to the default.
    }
    return `colorful`;
};

const explorerStyle: Ref<ExplorerStyle> = ref(read());

// Persist every change (including direct writes from the Settings picker), so no page needs a setter.
watch(explorerStyle, (value) => {
    try {
        localStorage.setItem(STORAGE_KEY, value);
    } catch {
        // Storage may be unavailable (private mode); the in-memory ref still holds.
    }
});

export function useExplorerStyle() {
    return { explorerStyle, explorerStyles };
}
