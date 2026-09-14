import { onMounted, onUnmounted, type Ref, watch } from "vue";
import { fitToContent } from "./desktop";

/// A height the page needs that is not in the measured column, or 0. Read as a floor, never as the answer.
export type HeightFloor = Ref<number>;

/* THE WINDOW IS AS TALL AS ITS PAGE (windows.rs `fit_to_content`). */
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
