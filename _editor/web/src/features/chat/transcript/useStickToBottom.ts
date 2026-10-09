import { onMounted, onUnmounted, type Ref, ref } from "vue";

// Stays pinned to the bottom unless the user scrolls up away from it; follow() re-pins on any change, keyed on scroll
// state rather than a panel-owned flag. Any upward scroll by the reader counts as leaving, however small: a soft wheel
// notch that stayed near the bottom and still counted as parked was dragged back down by the next layout change (a row
// realizing as it scrolls into view, a streamed token), which reads as the view flickering back. An upward move the
// layout caused (content shrinking under the reader clamps scrollTop) is not the reader leaving.

// How close to the bottom counts as parked again when the reader scrolls back down; absorbs sub-pixel rounding and
// saves them landing on the exact last pixel.
const THRESHOLD = 80;

// Both refs are template refs: null is what Vue writes into one once its element is gone, and every read here can
// land after that (a resize observation, a post-flush follow, an unmounting pane).
export const useStickToBottom = (
    scroller: Ref<HTMLElement | null>,
    content: Ref<HTMLElement | null>,
): { pin: () => void; follow: () => void; parked: Readonly<Ref<boolean>> } => {
    // Closure state, not refs: reads happen inside DOM callbacks where reactivity buys nothing.
    let pinned = true;
    // The same, for a reader outside the DOM callbacks (the row window, paneWindow.ts, which may take rows above down
    // only while the reader is at the newest). Written on every change of `pinned`; a ref set to the value it holds
    // triggers nothing, so a scroll that leaves the state alone costs no effect.
    const parked = ref(true);
    const park = (value: boolean): void => {
        pinned = value;
        parked.value = value;
    };
    let lastTop = 0;
    // Geometry at the last scroll measure; an upward move while either changed is the browser clamping, not the reader.
    let lastHeight = 0;
    let lastClient = 0;
    let observer: ResizeObserver | undefined;
    // Element the scroll listener attached to; the template ref is already cleared by unmount.
    let listening: HTMLElement | null = null;

    const measure = (element: HTMLElement): void => {
        lastTop = element.scrollTop;
        lastHeight = element.scrollHeight;
        lastClient = element.clientHeight;
    };

    const pin = (): void => {
        park(true);
        const element = scroller.value;
        if (element === null) {
            return;
        }
        element.scrollTop = element.scrollHeight;
        // Read back the clamped value; the next scroll event is measured against it.
        measure(element);
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
        const reshaped = element.scrollHeight !== lastHeight || element.clientHeight !== lastClient;
        measure(element);
        if (up) {
            if (!reshaped) {
                park(false);
            }
            return;
        }
        if (element.scrollHeight - top - element.clientHeight <= THRESHOLD) {
            park(true);
        }
    };

    // Wheel intent lands before the scroll it causes, and holds even when a reflow in the same frame reshapes the
    // content (which the scroll rule above then cannot tell from clamping).
    const onWheel = (event: WheelEvent): void => {
        if (event.deltaY < 0 && listening !== null && listening.scrollTop > 0) {
            park(false);
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
        measure(element);
        listening = element;
        element.addEventListener(`scroll`, onScroll, { passive: true });
        element.addEventListener(`wheel`, onWheel, { passive: true });
        observe();
    });

    onUnmounted(() => {
        observer?.disconnect();
        observer = undefined;
        listening?.removeEventListener(`scroll`, onScroll);
        listening?.removeEventListener(`wheel`, onWheel);
        listening = null;
    });

    return { pin, follow, parked };
};
