import { computed, shallowRef, type ComputedRef } from "vue";

// Unsaved work the edit buffers (useEditBuffers.ts) never see: an editor that keeps its own document, such as the office
// suite's, says here which paths it holds changes for. The close guard reads it beside the buffers' own dirty set, so
// closing a tab or a local window asks first whichever editor the edits are in (tabs/useCloseGuard.ts).

// allow(module-state): the one set every editor reports into and the close guard reads
const paths = shallowRef<ReadonlySet<string>>(new Set());

/** Marks `path` as holding unsaved changes, or no longer. The set is replaced, never edited, so a reader recomputes. */
export const setExternalDirty = (path: string, dirty: boolean): void => {
    if (paths.value.has(path) === dirty) {
        return;
    }
    const next = new Set(paths.value);
    if (dirty) {
        next.add(path);
    } else {
        next.delete(path);
    }
    paths.value = next;
};

export const externalDirtyPaths: ComputedRef<ReadonlySet<string>> = computed(() => paths.value);
