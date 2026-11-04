import { messageOr, useLatest } from "@intentic/extension-ui";
import { type Ref, ref } from "vue";

/* The part every document viewer repeated: a load that shows a spinner, says what went wrong in the file's own
   words, and never lets a slow load for the previous file land over the one now open.

   A load after one that drew is a refresh: the file changed on disk while open (an agent rewriting the document a
   reader is watching). It draws over the last rendering without a spinner, and when it fails, which is what a file
   read mid-write does (a Word file is a zip, and half a zip does not open), the last rendering stays and `stale` says
   so instead of an error covering it. The host reads the file again once its writes settle (FileViewer), and that
   load clears `stale`. */

export interface ViewerLoad {
    readonly loading: Ref<boolean>;
    readonly error: Ref<string | undefined>;
    // The pane shows an earlier version: the latest one could not be drawn, the one before it could.
    readonly stale: Ref<boolean>;
    /**
     * Starts a load that supersedes every earlier one. `work` gets the check it must make after each await: once it
     * answers false a newer load owns the pane, and `work` returns without touching it. Whatever `work` throws
     * becomes `error` (or `stale`, once something drew), and only a still-current load settles `loading`, `error` or
     * `stale`. `work` must leave the last rendering in place until it has the next one whole (`swapChildren`).
     */
    readonly start: (work: (isLatest: () => boolean) => Promise<void>) => Promise<void>;
    // Whether a load has drawn since the viewer mounted: what makes the next one a refresh.
    readonly drawn: () => boolean;
}

export interface ViewerLoadOptions {
    // A viewer the host can replace when it fails (the Word compare) is told the message as well as keeping it.
    readonly failed?: (message: string) => void;
}

// `fallback` is read when a load fails, not when the viewer mounts, so it follows a language switched in between.
export const useViewerLoad = (fallback: () => string, options: ViewerLoadOptions = {}): ViewerLoad => {
    const loading = ref(true);
    const error = ref<string>();
    const stale = ref(false);
    const latest = useLatest();
    let shown = false;

    const start: ViewerLoad["start"] = async (work) => {
        const isLatest = latest();
        const refreshing = shown;
        // A refresh draws over what is there; a spinner over a document the reader is reading would blank it per write.
        loading.value = !refreshing;
        error.value = undefined;
        try {
            await work(isLatest);
            if (isLatest()) {
                shown = true;
                stale.value = false;
            }
        } catch (caught) {
            if (!isLatest()) {
                return;
            }
            if (refreshing) {
                stale.value = true;
                return;
            }
            error.value = messageOr(caught, fallback());
            options.failed?.(error.value);
        } finally {
            if (isLatest()) {
                loading.value = false;
            }
        }
    };

    return { loading, error, stale, start, drawn: () => shown };
};
