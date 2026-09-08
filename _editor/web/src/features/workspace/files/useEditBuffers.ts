import { computed, reactive } from "vue";

// Per-file edit buffers for the workspace editor, as a module-level singleton so FileViewer and FileTabs read the
// same state and an unsaved buffer survives a tab switch. Keyed by root-relative path; dirty means the buffer
// differs from its on-disk baseline. Edit vs. view mode lives in useLayout, not here.

// Last text known to be on disk (set on load and after save); the dirty baseline.
const baseline = reactive(new Map<string, string>());
// Live edited text; present once a file has been opened in the editor.
const buffers = reactive(new Map<string, string>());

// Drops every buffer and baseline when the active sandbox changes, since these are keyed by path only and
// would otherwise carry over to the next sandbox.
export const resetEditBuffers = (): void => {
    baseline.clear();
    buffers.clear();
};

const isDirty = (path: string): boolean => buffers.has(path) && buffers.get(path) !== baseline.get(path);

export function useEditBuffers() {
    // Records on-disk text (first load or external refresh) without clobbering an in-progress edit.
    const setBaseline = (path: string, text: string): void => {
        baseline.set(path, text);
        if (!buffers.has(path)) {
            buffers.set(path, text);
        }
    };
    const setBuffer = (path: string, text: string): void => void buffers.set(path, text);
    const bufferOf = (path: string): string | undefined => buffers.get(path);
    // Compared against a fresh read to tell a real edit from the buffer's own save echo (equal means nothing new).
    const baselineOf = (path: string): string | undefined => baseline.get(path);
    // After a save, the buffer becomes the new on-disk text.
    const markSaved = (path: string, text: string): void => {
        baseline.set(path, text);
        buffers.set(path, text);
    };
    // Drops all state for a path when its tab closes.
    const forget = (path: string): void => {
        baseline.delete(path);
        buffers.delete(path);
    };

    const dirtyPaths = computed(() => new Set([...buffers.keys()].filter(isDirty)));

    return { isDirty, setBaseline, setBuffer, bufferOf, baselineOf, markSaved, forget, dirtyPaths };
}
