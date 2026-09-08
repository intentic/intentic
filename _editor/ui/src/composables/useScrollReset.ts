import { nextTick, watch, type Ref } from "vue";

// Resets the ancestor scrollport to top when `key` changes, for a page-owning scroll surface whose scroller
// outlives what it shows (unlike a bounded pane, which remounts fresh). Walks up the DOM to find the scrollport.
// Jumps instantly: this is a new subject, not a journey the reader asked for.

const scrollportOf = (start: HTMLElement): HTMLElement | undefined => {
    let el: HTMLElement | null = start.parentElement;
    while (el !== null) {
        const overflowY = getComputedStyle(el).overflowY;
        // `clip` and `hidden` are not scrollports here; <ScrollFrame> uses `clip` so it does not become one.
        if ((overflowY === `auto` || overflowY === `scroll`) && el.scrollHeight > el.clientHeight) {
            return el;
        }
        el = el.parentElement;
    }
    return undefined;
};

/**
 * Reset the nearest scrolling ancestor of `element` to the top whenever `key` changes.
 *
 * @param element An element inside the scrollport; the view's own root is the usual choice.
 * @param key What the scroll position is about; changing it means the old position no longer applies.
 */
export function useScrollReset(element: Readonly<Ref<HTMLElement | undefined>>, key: () => unknown): void {
    watch(key, async () => {
        // Waits for the new key's render; scrolling before then hits the old, still-tall scrollport height.
        await nextTick();
        const el = element.value;
        if (el === undefined) {
            return;
        }
        const scrollport = scrollportOf(el);
        if (scrollport !== undefined) {
            scrollport.scrollTop = 0;
        }
    });
}
