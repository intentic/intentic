import { computed, type Ref, watch } from "vue";
import { useStickToBottom } from "../../transcript/useStickToBottom";
import { useTranscriptWarmup } from "../../transcript/useTranscriptWarmup";

// Where the pane's scroller stands: at the newest message whenever another transcript comes on screen or a strip that
// withheld its turns shows them, then following new rows unless the reader scrolled up; and the one idle-time pass
// after a transcript lands whole, so the scrollbar's height is honest.

export interface PaneScrollHost {
    readonly scroller: Ref<HTMLElement | null>;
    readonly content: Ref<HTMLElement | null>;
    readonly conversationId: () => string;
    // The turns are withheld (the quick bar's strip); a scroller that has just gained them sits at the oldest words.
    readonly bare: () => boolean | undefined;
    readonly messageCount: () => number;
    readonly streaming: Readonly<Ref<boolean>>;
    // Sizes the box, since the chat now on screen may hold another draft.
    readonly grow: () => void;
}

export const usePaneScroll = (pane: PaneScrollHost) => {
    const { pin, follow } = useStickToBottom(pane.scroller, pane.content);
    const { realizing } = useTranscriptWarmup({
        conversationId: computed(pane.conversationId),
        messageCount: computed(pane.messageCount),
        streaming: pane.streaming,
    });
    // Post-flush, both: the transcript now on screen has to be in the DOM to be scrolled to.
    watch(
        pane.conversationId,
        () => {
            pin();
            pane.grow();
        },
        { flush: `post` },
    );
    watch(
        pane.bare,
        (withheld) => {
            if (withheld !== true) {
                pin();
                pane.grow();
            }
        },
        { flush: `post` },
    );
    // On length and streaming rather than on resize observations, which the browser can coalesce past the layout that
    // produced them.
    watch([pane.messageCount, pane.streaming], follow, { flush: `post` });
    return { pin, realizing };
};
