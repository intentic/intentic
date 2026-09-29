import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from "vue";
import { confirmDesktopWindowClose, markDesktopWindowDirty } from "../app/environments/desktop";
import { LOCAL_CLOSE_REQUESTED_EVENT } from "../app/environments/local";
import { externalDirtyPaths, setExternalDirty } from "../features/workspace/files/externalDirty";
import { useEditBuffers } from "../features/workspace/files/useEditBuffers";
import { useWorkspaceTabs } from "../features/workspace/tabs/useWorkspaceTabs";

// A local window's unsaved work, and every close that would lose it. The desktop app is told whenever the window turns
// dirty or clean (and once on mount), holds back a close it believes would lose work and asks the page
// (`intentic:close-requested`), which asks the reader and answers only with a close they agreed to. A tab holding edits
// asks the same question before its × or Ctrl/Cmd+W discards them: the window has no other copy of what was typed.
// Unsaved is either kind: the editor's own buffers, and what an editor keeping its own document reports (externalDirty).

/** What a close would discard, and the close itself, run once the reader agrees. */
export interface CloseQuestion {
    readonly what: `tab` | `window`;
    readonly paths: readonly string[];
    readonly close: () => void;
}

export const useUnsavedGuard = () => {
    const { dirtyPaths, forget } = useEditBuffers();
    const { strip, closeTabIds } = useWorkspaceTabs();
    const unsavedAt = (path: string): boolean => dirtyPaths.value.has(path) || externalDirtyPaths.value.has(path);
    const dirty = computed(() => dirtyPaths.value.size > 0 || externalDirtyPaths.value.size > 0);

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
    const filesOf = (id: string): readonly string[] =>
        [...strip.value.main.tabs, ...strip.value.side.tabs].flatMap((tab) => (tab.id === id && tab.kind === `file` ? [tab.path] : []));
    /** Closes a tab as its × does: at once, unless it holds unsaved edits, which go only once the reader agrees. */
    const closeTab = (id: string): void => {
        const close = (): void => closeTabIds(new Set([id])).forEach(forgetPath);
        const unsaved = filesOf(id).filter(unsavedAt);
        if (unsaved.length === 0) {
            close();
            return;
        }
        ask({ what: `tab`, paths: unsaved, close });
    };

    const onCloseRequested = (): void => {
        if (!dirty.value) {
            confirmDesktopWindowClose();
            return;
        }
        ask({ what: `window`, paths: [...new Set([...dirtyPaths.value, ...externalDirtyPaths.value])].toSorted(), close: confirmDesktopWindowClose });
    };
    const closeAnyway = (): void => {
        if (!asking.value) {
            return;
        }
        asking.value = false;
        question.value?.close();
    };
    // Nothing to tell the app: a close it held back simply does not happen, and a tab stays as it was.
    const keepOpen = (): void => {
        asking.value = false;
    };

    watch(dirty, (value) => markDesktopWindowDirty(value));
    onMounted(() => {
        markDesktopWindowDirty(dirty.value);
        window.addEventListener(LOCAL_CLOSE_REQUESTED_EVENT, onCloseRequested);
    });
    onUnmounted(() => window.removeEventListener(LOCAL_CLOSE_REQUESTED_EVENT, onCloseRequested));

    return { question, asking, closeTab, closeAnyway, keepOpen };
};
