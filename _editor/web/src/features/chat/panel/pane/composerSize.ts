import { afterResize, growTextarea } from "@intentic/ui";
import { onBeforeUnmount, type Ref, ref, watch } from "vue";

// The composer box grows with its words up to what the pane can spare: the scroller's free height less the composer's
// chrome and a strip of transcript left in view, floored, and measured again whenever the pane's space changes.

// The cap's floor, and the transcript a grown box always leaves showing above it.
const COMPOSER_FLOOR = 192;
const TRANSCRIPT_PEEK = 72;

/**
 * Whether the browser sizes the box to its own text, placeholder included (`field-sizing: content`, Chromium): the box
 * wears the class that asks for it (ChatPane.vue), and nothing here measures it. Elsewhere growTextarea does, which
 * for an empty box means swapping its placeholder in as its value and out again around a forced layout: done on every
 * frame of a drag of the chat's edge, it made this the costliest resize observer on the page.
 */
const sizesItself = (): boolean => `CSS` in globalThis && CSS.supports(`field-sizing`, `content`);

// The three elements the measurement reads: the scroller, the sticky footer (textarea included), the textarea.
export interface ComposerElements {
    readonly scroller: Readonly<Ref<HTMLElement | null>>;
    readonly footer: Readonly<Ref<HTMLElement | null>>;
    readonly input: Readonly<Ref<HTMLTextAreaElement | null>>;
}

export const useComposerSize = (elements: ComposerElements) => {
    const composerCap = ref(COMPOSER_FLOOR);
    const native = sizesItself();
    // Nothing laid out yet measures nothing, so the last good cap stands. Null, not undefined: this runs off
    // `nextTick`, by which point the composer may have gone and Vue has nulled the refs.
    const measureCap = (): void => {
        const box = elements.scroller.value;
        const shell = elements.footer.value;
        const field = elements.input.value;
        if (box === null || shell === null || field === null || shell.offsetHeight <= 0) {
            return;
        }
        const chrome = shell.offsetHeight - field.offsetHeight;
        composerCap.value = Math.max(COMPOSER_FLOOR, box.clientHeight - chrome - TRANSCRIPT_PEEK);
    };
    // Callers re-measure after the DOM updated (`nextTick`, a post-flush watch): layout lands after the DOM does.
    const grow = (): void => {
        measureCap();
        if (!native) {
            growTextarea(elements.input.value, composerCap.value);
        }
    };

    // Only the scroller is observed: watching the footer too would loop, since growing the box changes its height. A
    // resize handle being dragged (the chat's edge, the terminal's) holds the measurement until the pointer rests or lets
    // go, so a drag measures the box once rather than once a frame.
    let waiting = (): void => {};
    const paneSize = `ResizeObserver` in globalThis ? new ResizeObserver(() => (waiting = afterResize(grow))) : undefined;
    watch(
        elements.scroller,
        (now, before) => {
            if (before !== null && before !== undefined) {
                paneSize?.unobserve(before);
            }
            if (now !== null) {
                paneSize?.observe(now);
            }
        },
        { immediate: true },
    );
    onBeforeUnmount(() => {
        paneSize?.disconnect();
        waiting();
    });

    return { composerCap, grow };
};
