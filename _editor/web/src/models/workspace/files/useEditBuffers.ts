import { sandboxRef } from "@intentic/extension-api";
import { computed, toValue, type MaybeRefOrGetter } from "vue";
import { scopeKey, SHARED_SCOPE, type ViewScope } from "../../../app/workspaceScope";

// Per-file edit buffers for the workspace editor, as a module-level singleton so FileViewer and FileTabs read the
// same state and an unsaved buffer survives a tab switch. Keyed by root-relative path, which names a file in one
// checkout, so both maps are sandbox-scoped. Dirty means the buffer differs from its on-disk baseline.

// Last text known to be on disk (set on load and after save); the dirty baseline.
const baseline = sandboxRef(() => new Map<string, string>());
// Live edited text; present once a file has been opened in the editor.
const buffers = sandboxRef(() => new Map<string, string>());

// Drops every buffer and baseline: the tree moved under them (a pull, a discard, a restore, a checkout elsewhere), so
// none is an edit of what is on disk any more.
export const dropEditBuffers = (view?: ViewScope): void => {
    for (const map of [baseline.value, buffers.value]) {
        for (const key of map.keys()) {
            if (view === undefined || key.startsWith(`${scopeKey(view)}\0`)) { map.delete(key); }
        }
    }
};

// Window close and page unload must include buffers in checkouts that are no longer on screen.
export const allDirtyPaths = computed(() => new Set([...buffers.value]
    .filter(([key, text]) => text !== baseline.value.get(key))
    .map(([key]) => key.slice(key.indexOf(`\0`) + 1))));

export function useEditBuffers(view: MaybeRefOrGetter<ViewScope> = SHARED_SCOPE) {
    const keyOf = (path: string): string => `${scopeKey(toValue(view))}\0${path}`;
    const isDirty = (path: string): boolean => buffers.value.has(keyOf(path)) && buffers.value.get(keyOf(path)) !== baseline.value.get(keyOf(path));
    // Records on-disk text (first load or external refresh) without clobbering an in-progress edit.
    const setBaseline = (path: string, text: string): void => {
        baseline.value.set(keyOf(path), text);
        if (!buffers.value.has(keyOf(path))) {
            buffers.value.set(keyOf(path), text);
        }
    };
    const setBuffer = (path: string, text: string): void => void buffers.value.set(keyOf(path), text);
    const bufferOf = (path: string): string | undefined => buffers.value.get(keyOf(path));
    // Compared against a fresh read to tell a real edit from the buffer's own save echo (equal means nothing new).
    const baselineOf = (path: string): string | undefined => baseline.value.get(keyOf(path));
    // After a save, the buffer becomes the new on-disk text.
    const markSaved = (path: string, text: string): void => {
        baseline.value.set(keyOf(path), text);
        buffers.value.set(keyOf(path), text);
    };
    // Drops all state for a path when its tab closes.
    const forget = (path: string): void => {
        baseline.value.delete(keyOf(path));
        buffers.value.delete(keyOf(path));
    };
    // Follows a file that moved on disk. Without it a rename strands unsaved work at a path nothing reads any more,
    // and the tab that reopens at the new name comes back with the on-disk text instead.
    const renamePath = (from: string, to: string): void => {
        const text = buffers.value.get(keyOf(from));
        const disk = baseline.value.get(keyOf(from));
        if (text === undefined && disk === undefined) {
            return;
        }
        if (disk !== undefined) {
            baseline.value.set(keyOf(to), disk);
        }
        if (text !== undefined) {
            buffers.value.set(keyOf(to), text);
        }
        forget(from);
    };

    const dirtyPaths = computed(() => {
        const prefix = `${scopeKey(toValue(view))}\0`;
        return new Set([...buffers.value.keys()].filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length)).filter(isDirty));
    });

    return { isDirty, setBaseline, setBuffer, bufferOf, baselineOf, markSaved, forget, renamePath, dirtyPaths };
}
