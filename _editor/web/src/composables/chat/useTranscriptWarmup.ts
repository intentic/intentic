import { nextTick, type Ref, ref, watch } from "vue";

/* MAKE THE NATIVE SCROLLBAR TRUTHFUL AFTER A TRANSCRIPT LANDS WHOLESALE.
 *
 * .chat-message rows are content-visibility:auto with a 3rem estimate (chat.css), so a freshly swapped-in
 * transcript reports a scrollHeight built almost entirely of estimates. Left alone, every row realizing on the
 * way past rewrites scrollHeight mid-scroll, and a native scrollbar DRAG maps the thumb against the current
 * scrollHeight, so the thumb kept leaping hundreds of px away from the cursor. The cure is one idle-time
 * realization pass: .chat-realize forces every row to lay out for real, `auto` records those heights as
 * remembered sizes, and skipping resumes with a scrollHeight that no longer moves.
 *
 * Two frames under the class on purpose: the first lays the realized transcript out and records remembered sizes
 * (that happens at resize-observer timing, at the end of the frame), the second may drop back to skipping. A
 * followed transcript survives the growth spurt through useStickToBottom's own observer; elsewhere scroll
 * anchoring holds the view. requestIdleCallback keeps the one full layout off the restore's critical path
 * (Safari has no idle callback, a beat of setTimeout is the same bargain). */

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

    /* This window, unless there is no window at all: a torn-down document, which happens between a deferred
     * callback being queued and it running (a unit test's environment closing under an idle task).
     * `globalThis.window` rather than a bare `window`, because the bare identifier THROWS where the property
     * merely reads undefined. */
    const painter = (): (Window & typeof globalThis) | undefined => globalThis.window;

    const whenIdle = (task: () => void): void => {
        const view = painter();
        if (view === undefined) {
            // Nothing left to schedule against. The work is a scroll warm-up, so dropping it costs a frame of
            // layout on a pane that no longer exists.
            return;
        }
        if (view.requestIdleCallback === undefined) {
            view.setTimeout(task, IDLE_FALLBACK_MS);
            return;
        }
        view.requestIdleCallback(task);
    };

    const warm = (): void => {
        if (queued) {
            return;
        }
        queued = true;
        whenIdle(() => {
            realizing.value = true;
            void nextTick(() => {
                const view = painter();
                if (view === undefined) {
                    // The document went away between the idle callback and this tick. Clear the latch by hand,
                    // since the frames that would have cleared it are never going to run.
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

    // Every path that mounts never-painted rows outside the viewport, and nothing that fires per streamed frame:
    // a tab switch or history open swaps the whole list (conversationId), the IndexedDB repaint and the daemon's
    // replay land in bulk (length jumps while idle, a live turn only ever appends one bubble per flush), and a
    // turn's end covers an answer that streamed in below the fold while the user was scrolled up reading.
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
