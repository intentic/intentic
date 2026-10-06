import { onMounted, onUnmounted, watch } from "vue";
import { confirmDesktopWindowClose, markDesktopWindowDirty } from "../app/environments/desktop";
import { LOCAL_CLOSE_REQUESTED_EVENT } from "../app/environments/local";
import { useCloseGuard } from "../features/workspace/tabs/useCloseGuard";

// A local window's unsaved work, and every close that would lose it. The tabs' side is the workspace's own guard
// (useCloseGuard.ts); this adds the window. The desktop app is told whenever the window turns dirty or clean (and once on
// mount), holds back a close it believes would lose work and asks the page (`intentic:close-requested`), which asks the
// reader and answers only with a close they agreed to.

export const useUnsavedGuard = () => {
    const guard = useCloseGuard();
    const { dirty, unsavedPaths, ask } = guard;

    const onCloseRequested = (): void => {
        if (!dirty.value) {
            confirmDesktopWindowClose();
            return;
        }
        ask({ what: `window`, paths: unsavedPaths(), close: confirmDesktopWindowClose });
    };

    watch(dirty, (value) => markDesktopWindowDirty(value));
    onMounted(() => {
        markDesktopWindowDirty(dirty.value);
        window.addEventListener(LOCAL_CLOSE_REQUESTED_EVENT, onCloseRequested);
    });
    onUnmounted(() => window.removeEventListener(LOCAL_CLOSE_REQUESTED_EVENT, onCloseRequested));

    return guard;
};
