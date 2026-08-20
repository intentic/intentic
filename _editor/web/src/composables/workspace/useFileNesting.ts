import { ref, watch, type Ref } from "vue";

const STORAGE_KEY = `ui-file-nesting`;

/* Owns the file-nesting toggle as a module-level singleton, mirroring useExplorerStyle. Deliberately binary:
 * no per-pattern rules, when on, every directory that holds a package.json folds its other files under it
 * (see pages/workspace/fileNesting.ts). Persisted to localStorage; defaults to on. */

const read = (): boolean => {
    try {
        return localStorage.getItem(STORAGE_KEY) !== `off`;
    } catch {
        // Storage may be unavailable (private mode); fall back to the default.
        return true;
    }
};

const fileNesting: Ref<boolean> = ref(read());

// Persist every change (including direct writes from the Settings toggle), so no page needs a setter.
watch(fileNesting, (value) => {
    try {
        localStorage.setItem(STORAGE_KEY, value ? `on` : `off`);
    } catch {
        // Storage may be unavailable (private mode); the in-memory ref still holds.
    }
});

export function useFileNesting() {
    return { fileNesting };
}
