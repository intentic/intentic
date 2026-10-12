import { messageOr, useLatest } from "@intentic/extension-ui";
import { type Ref, ref } from "vue";

/* The part every document viewer repeated: a load that shows a spinner, says what went wrong in the file's own
   words, and never lets a slow load for the previous file land over the one now open. */

export interface ViewerLoad {
    readonly loading: Ref<boolean>;
    readonly error: Ref<string | undefined>;
    /**
     * Starts a load that supersedes every earlier one. `work` gets the check it must make after each await: once it
     * answers false a newer load owns the pane, and `work` returns without touching it. Whatever `work` throws
     * becomes `error`, and only a still-current load settles `loading` or `error`.
     */
    readonly start: (work: (isLatest: () => boolean) => Promise<void>) => Promise<void>;
}

export interface ViewerLoadOptions {
    // A viewer the host can replace when it fails (the Word compare) is told the message as well as keeping it.
    readonly failed?: (message: string) => void;
}

// `fallback` is read when a load fails, not when the viewer mounts, so it follows a language switched in between.
export const useViewerLoad = (fallback: () => string, options: ViewerLoadOptions = {}): ViewerLoad => {
    const loading = ref(true);
    const error = ref<string>();
    const latest = useLatest();

    const start: ViewerLoad["start"] = async (work) => {
        const isLatest = latest();
        loading.value = true;
        error.value = undefined;
        try {
            await work(isLatest);
        } catch (caught) {
            if (isLatest()) {
                error.value = messageOr(caught, fallback());
                options.failed?.(error.value);
            }
        } finally {
            if (isLatest()) {
                loading.value = false;
            }
        }
    };

    return { loading, error, start };
};
