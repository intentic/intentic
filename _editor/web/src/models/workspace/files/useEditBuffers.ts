import { sandboxRef } from "@intentic/extension-api";
import { computed } from "vue";

// Per-file edit buffers for the workspace editor, as a module-level singleton so FileViewer and FileTabs read the
// same state and an unsaved buffer survives a tab switch. Keyed by root-relative path, which names a file in one
// sandbox's /work, so both maps are sandbox-scoped. Dirty means the buffer differs from its on-disk baseline.

// Last text known to be on disk (set on load and after save); the dirty baseline.
const baseline = sandboxRef(() => new Map<string, string>());
// Live edited text; present once a file has been opened in the editor.
const buffers = sandboxRef(() => new Map<string, string>());

// Drops every buffer and baseline: the tree moved under them (a pull, a discard, a restore, a checkout elsewhere), so
// none is an edit of what is on disk any more.
export const dropEditBuffers = (): void => {
    baseline.value.clear();
    buffers.value.clear();
};

const isDirty = (path: string): boolean => buffers.value.has(path) && buffers.value.get(path) !== baseline.value.get(path);

export function useEditBuffers() {
    // Records on-disk text (first load or external refresh) without clobbering an in-progress edit.
    const setBaseline = (path: string, text: string): void => {
        baseline.value.set(path, text);
        if (!buffers.value.has(path)) {
            buffers.value.set(path, text);
        }
    };
    const setBuffer = (path: string, text: string): void => void buffers.value.set(path, text);
    const bufferOf = (path: string): string | undefined => buffers.value.get(path);
    // Compared against a fresh read to tell a real edit from the buffer's own save echo (equal means nothing new).
    const baselineOf = (path: string): string | undefined => baseline.value.get(path);
    // After a save, the buffer becomes the new on-disk text.
    const markSaved = (path: string, text: string): void => {
        baseline.value.set(path, text);
        buffers.value.set(path, text);
    };
    // Drops all state for a path when its tab closes.
    const forget = (path: string): void => {
        baseline.value.delete(path);
        buffers.value.delete(path);
    };
    // Follows a file that moved on disk. Without it a rename strands unsaved work at a path nothing reads any more,
    // and the tab that reopens at the new name comes back with the on-disk text instead.
    const renamePath = (from: string, to: string): void => {
        const text = buffers.value.get(from);
        const disk = baseline.value.get(from);
        if (text === undefined && disk === undefined) {
            return;
        }
        if (disk !== undefined) {
            baseline.value.set(to, disk);
        }
        if (text !== undefined) {
            buffers.value.set(to, text);
        }
        forget(from);
    };

    const dirtyPaths = computed(() => new Set([...buffers.value.keys()].filter(isDirty)));

    return { isDirty, setBaseline, setBuffer, bufferOf, baselineOf, markSaved, forget, renamePath, dirtyPaths };
}
