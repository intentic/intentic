import { onMounted, onUnmounted, type Ref, watch } from "vue";
import { fitToContent } from "./desktop";

/// A height the page needs that is not in the measured column, or 0. Read as a floor, never as the answer.
export type HeightFloor = Ref<number>;

/* THE WINDOW IS AS TALL AS ITS PAGE (windows.rs `fit_to_content`).
 *
 * Both of this app's local faces are cards: a fixed width the Rust side owns, and a height that is whatever
 * their content came to. Only the content knows that, and it changes: a requirements list arrives, a run's
 * rows fill in, a log opens. So the page watches its own content box and tells the window, and the window
 * follows, which is what lets the app draw no title bar and no empty canvas around what it has to say.
 *
 * `offsetHeight` of the CONTENT element, never the document's: the root is the viewport-tall scroll container
 * the fit clamps into, and measuring it would report the window's own height straight back to it. Rounded up,
 * so a fractional line never leaves a one-pixel scrollbar. Coalesced to a frame, because one layout pass
 * fires the observer several times and one resize per frame is all a window can use.
 *
 * `floor` is for what the column CANNOT measure: an overlay is `position: fixed`, so a modal this page raises
 * contributes nothing to `offsetHeight` and the window would stay card-tall around a dialog that then has
 * nowhere to draw. It must not be derived from the window's own size, or every resize would feed the next. */
export function useFitToContent(content: Ref<HTMLElement | undefined>, floor?: HeightFloor): void {
    let observer: ResizeObserver | undefined;
    let frame: number | undefined;
    let reported = -1;
    const report = (): void => {
        frame = undefined;
        const element = content.value;
        if (element === undefined) {
            return;
        }
        const height = Math.max(Math.ceil(element.offsetHeight), floor?.value ?? 0);
        if (height === 0 || height === reported) {
            return;
        }
        reported = height;
        void fitToContent(height);
    };
    // The floor moving is a resize nothing in the column performed, so the observer never hears about it.
    if (floor !== undefined) {
        watch(floor, () => {
            frame ??= requestAnimationFrame(report);
        });
    }
    onMounted(() => {
        const element = content.value;
        if (element === undefined) {
            return;
        }
        observer = new ResizeObserver(() => {
            frame ??= requestAnimationFrame(report);
        });
        observer.observe(element);
        report();
    });
    onUnmounted(() => {
        observer?.disconnect();
        if (frame !== undefined) {
            cancelAnimationFrame(frame);
        }
    });
}
