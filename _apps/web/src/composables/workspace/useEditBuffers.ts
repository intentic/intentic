import { computed, reactive } from "vue";

/* Per-file edit buffers for the workspace editor, as a module-level singleton (like useSandbox) so the editor
 * (FileViewer) and the tab strip's dirty dots (FileTabs) read the SAME state, and an unsaved buffer survives a
 * tab switch. Keyed by root-relative path. A file is "dirty" when its live buffer differs from the last text we
 * know is on disk (its baseline). Edit vs. view is a single global flag in useLayout, not tracked here. */

// Last text known to be on disk (set on load + after a save); the dirty baseline.
const baseline = reactive(new Map<string, string>());
// The live edited text; present once a file has been opened in the editor.
const buffers = reactive(new Map<string, string>());

// Drop every buffer/baseline when the active sandbox changes (see sandboxScope) — these are keyed by path only,
// so a dirty buffer would otherwise carry from one sandbox onto the next.
export const resetEditBuffers = (): void => {
    baseline.clear();
    buffers.clear();
};

const isDirty = (path: string): boolean => buffers.has(path) && buffers.get(path) !== baseline.get(path);

export function useEditBuffers() {
    // Record the on-disk text (first load / external refresh) without clobbering an in-progress edit.
    const setBaseline = (path: string, text: string): void => {
        baseline.set(path, text);
        if (!buffers.has(path)) {
            buffers.set(path, text);
        }
    };
    const setBuffer = (path: string, text: string): void => void buffers.set(path, text);
    const bufferOf = (path: string): string | undefined => buffers.get(path);
    // After a successful save, the buffer IS the new on-disk text.
    const markSaved = (path: string, text: string): void => {
        baseline.set(path, text);
        buffers.set(path, text);
    };
    // Drop all state for a path (its tab closed).
    const forget = (path: string): void => {
        baseline.delete(path);
        buffers.delete(path);
    };

    const dirtyPaths = computed(() => new Set([...buffers.keys()].filter(isDirty)));

    return { isDirty, setBaseline, setBuffer, bufferOf, markSaved, forget, dirtyPaths };
}
