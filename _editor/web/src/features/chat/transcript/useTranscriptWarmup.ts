import { useDevice } from "@intentic/ui";
import { nextTick, type Ref, ref, watch } from "vue";

// Forces content-visibility:auto rows (chat.css) to lay out for real after a transcript swap, since scrollHeight is
// otherwise built from estimates. Two frames under .chat-realize: the first records remembered sizes, the second drops
// back to skipping; requestIdleCallback (a timeout on Safari) keeps it off the critical path.

// Safari's stand-in for an idle callback.
const IDLE_FALLBACK_MS = 200;

export const useTranscriptWarmup = (transcript: {
    /** A new transcript on screen, a tab switch, a history open. */
    readonly conversationId: Ref<string>;
    /** Rows in the list, watched for the bulk arrivals rather than for a streamed frame. */
    readonly messageCount: Ref<number>;
    readonly streaming: Ref<boolean>;
}): { readonly realizing: Ref<boolean> } => {
    const realizing = ref(false);
    let queued = false;

    // This window, or undefined if the document has torn down between scheduling and running a deferred callback. Uses
    // globalThis.window, not a bare window, since the bare identifier throws when undefined.
    const painter = (): (Window & typeof globalThis) | undefined => globalThis.window;

    const whenIdle = (task: () => void): void => {
        const view = painter();
        if (view === undefined) {
            // No window to schedule against; the pane this warm-up targets is already gone.
            return;
        }
        if (view.requestIdleCallback === undefined) {
            view.setTimeout(task, IDLE_FALLBACK_MS);
            return;
        }
        view.requestIdleCallback(task);
    };

    // Not on a phone. The pass lays out every row of the chat at once, which a laptop pays in a frame and a phone pays in
    // a long one, at a chat's opening and again as every turn ends; what it buys is an exact scrollbar, and a phone's
    // scrollbar is an overlay that shows only while the finger moves. Rows there take their real height as they come
    // into view, and scroll anchoring holds the reader's place when one above them does.
    const { mobile, coarse } = useDevice();
    const warm = (): void => {
        if (queued || mobile.value || coarse.value) {
            return;
        }
        queued = true;
        whenIdle(() => {
            realizing.value = true;
            void nextTick(() => {
                const view = painter();
                if (view === undefined) {
                    // Document gone before this tick; clear the latch by hand, the scheduled frames won't run.
                    realizing.value = false;
                    queued = false;
                    return;
                }
                view.requestAnimationFrame(() =>
                    view.requestAnimationFrame(() => {
                        realizing.value = false;
                        queued = false;
                    }),
                );
            });
        });
    };

    // Warms up on:
    // - a new transcript (tab switch, history open)
    // - a bulk arrival of messages while idle
    // - a streamed turn ending
    watch(transcript.conversationId, warm, { immediate: true });
    watch(transcript.messageCount, (now, before) => {
        if (!transcript.streaming.value && Math.abs(now - before) > 1) {
            warm();
        }
    });
    watch(transcript.streaming, (now, was) => {
        if (was && !now) {
            warm();
        }
    });
    return { realizing };
};
