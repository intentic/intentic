import { computed, ref, shallowRef } from "vue";
import { externalDirtyPaths, setExternalDirty } from "../files/externalDirty";
import { useEditBuffers } from "../files/useEditBuffers";
import { useWorkspaceTabs } from "./useWorkspaceTabs";

// The one guard in front of every close that would lose unsaved work, in the hosted workspace and in a local window
// alike. Unsaved is either kind: the editor's own buffers, and what an editor keeping its own document reports
// (externalDirty.ts, which the Office and other extension editors set). A close that takes none of it happens at once;
// one that does waits for the reader's word, and then takes the edits and the dirty flag with the tabs, so nothing
// keeps reporting a file that is no longer open.
//
// (2026-10-05) A lone × close of a dirty tab asks too, as the local window always did. The hosted workspace used to
// close it silently on the grounds that the dirty dot already showed, but the buffer went with the tab, so Reopen
// Closed Tab brought back the file without what was typed; rejected for losing work on one click.

/** What a close would discard, and the close itself, run once the reader agrees. */
export interface CloseQuestion {
    readonly what: `tab` | `tabs` | `window`;
    readonly paths: readonly string[];
    readonly close: () => void;
}

export const useCloseGuard = () => {
    const { dirtyPaths, forget } = useEditBuffers();
    const { strip, closeTabIds } = useWorkspaceTabs();
    const unsavedAt = (path: string): boolean => dirtyPaths.value.has(path) || externalDirtyPaths.value.has(path);
    const dirty = computed(() => dirtyPaths.value.size > 0 || externalDirtyPaths.value.size > 0);
    /** Every unsaved file, whichever editor holds it, in a stable order. */
    const unsavedPaths = (): readonly string[] => [...new Set([...dirtyPaths.value, ...externalDirtyPaths.value])].toSorted();

    // The last question asked, kept after it is answered so the box says the same thing while it fades; `asking` is
    // whether it is up.
    const question = shallowRef<CloseQuestion | undefined>(undefined);
    const asking = ref(false);
    const ask = (next: CloseQuestion): void => {
        question.value = next;
        asking.value = true;
    };

    // A closed tab's edits go with it, whichever editor held them, and the dirty flag reads the same accounts.
    const forgetPath = (path: string): void => {
        forget(path);
        setExternalDirty(path, false);
    };
    // Both panes: a companion pane's unsaved work is the easiest to miss.
    const filesOf = (ids: ReadonlySet<string>): readonly string[] =>
        [...strip.value.main.tabs, ...strip.value.side.tabs].flatMap((tab) => (ids.has(tab.id) && tab.kind === `file` ? [tab.path] : []));

    /** Closes tabs: at once, unless one holds unsaved edits, in which case only once the reader agrees. */
    const closeTabs = (ids: ReadonlySet<string>): void => {
        const close = (): void => closeTabIds(ids).forEach(forgetPath);
        const unsaved = [...new Set(filesOf(ids).filter(unsavedAt))];
        if (unsaved.length === 0) {
            close();
            return;
        }
        ask({ what: ids.size === 1 ? `tab` : `tabs`, paths: unsaved, close });
    };
    /** Closes one tab as its × does. */
    const closeTab = (id: string): void => closeTabs(new Set([id]));

    const closeAnyway = (): void => {
        if (!asking.value) {
            return;
        }
        asking.value = false;
        question.value?.close();
    };
    // A close the reader turned down simply does not happen: the tabs stay as they were.
    const keepOpen = (): void => {
        asking.value = false;
    };

    return { dirty, unsavedPaths, question, asking, ask, closeTab, closeTabs, closeAnyway, keepOpen };
};
