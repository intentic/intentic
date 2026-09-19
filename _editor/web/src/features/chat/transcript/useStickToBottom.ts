import { onMounted, onUnmounted, type Ref } from "vue";

// Stays pinned to the bottom unless the user scrolls up away from it; follow() re-pins on any change, keyed on scroll
// state rather than a panel-owned flag. Only an upward scroll that lands away from the bottom counts as leaving.

// How close to the bottom still counts as parked; absorbs stray wheel notches and sub-pixel rounding.
const THRESHOLD = 80;

// Both refs are template refs: null is what Vue writes into one once its element is gone, and every read here can
// land after that (a resize observation, a post-flush follow, an unmounting pane).
export const useStickToBottom = (
    scroller: Ref<HTMLElement | null>,
    content: Ref<HTMLElement | null>,
): { pin: () => void; follow: () => void } => {
    // Closure state, not refs: reads happen inside DOM callbacks where reactivity buys nothing.
    let pinned = true;
    let lastTop = 0;
    let observer: ResizeObserver | undefined;
    // Element the scroll listener attached to; the template ref is already cleared by unmount.
    let listening: HTMLElement | null = null;

    const pin = (): void => {
        pinned = true;
        const element = scroller.value;
        if (element === null) {
            return;
        }
        element.scrollTop = element.scrollHeight;
        // Read back the clamped value; the next scroll event is measured against it.
        lastTop = element.scrollTop;
    };

    // Re-pins if the reader hasn't left the bottom. Called by the resize observers and by the panel's
    // transcript-changed watch, since a resize observation can be coalesced or deferred past the growth that caused it.
    const follow = (): void => {
        if (pinned) {
            pin();
        }
    };

    const onScroll = (): void => {
        const element = scroller.value;
        if (element === null) {
            return;
        }
        const top = element.scrollTop;
        const up = top < lastTop;
        lastTop = top;
        if (element.scrollHeight - top - element.clientHeight <= THRESHOLD) {
            pinned = true;
            return;
        }
        if (up) {
            pinned = false;
        }
    };

    // Watches two boxes: the content wrapper (grows with streamed tokens, images, reflow) and the scroller's content
    // box (shrinks when the panel, composer, or keyboard resizes it). Neither implies the other.
    const observe = (): void => {
        observer?.disconnect();
        observer = undefined;
        const element = scroller.value;
        const wrapper = content.value;
        if (element === null || wrapper === null) {
            return;
        }
        observer = new ResizeObserver(follow);
        observer.observe(wrapper);
        observer.observe(element, { box: `content-box` });
    };

    onMounted(() => {
        const element = scroller.value;
        if (element === null) {
            return;
        }
        lastTop = element.scrollTop;
        listening = element;
        element.addEventListener(`scroll`, onScroll, { passive: true });
        observe();
    });

    onUnmounted(() => {
        observer?.disconnect();
        observer = undefined;
        listening?.removeEventListener(`scroll`, onScroll);
        listening = null;
    });

    return { pin, follow };
};
