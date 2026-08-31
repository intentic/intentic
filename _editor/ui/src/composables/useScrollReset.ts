import { nextTick, watch, type Ref } from "vue";

/* BACK TO THE TOP WHEN THE SUBJECT CHANGES, on a surface where the PAGE owns the scroll.
 *
 * A bounded pane never needed this. Its body is its own scroller, the view keys it by whatever it is showing
 * (`<ScrollFrame :key="page">`), and a remount hands back a fresh scroller sitting at zero. Give the scroll to
 * the page and that guarantee is gone: the scrollport belongs to the shell's router-view, outlives every
 * selection, and remembers a position that was about a document you are no longer reading.
 *
 * WHAT THAT LOOKS LIKE is worth writing down, because it reads as data loss rather than as a scroll bug. Arrow
 * down the knowledge index while four screens into a long note and the next note renders under you at offset
 * 2000: you are looking at the middle of a note you never opened, with no way to know the top exists. Worse
 * when the new document is SHORTER than the old offset, the browser clamps to the end, so a one-paragraph note
 * arrives scrolled to its own footer and reads as empty.
 *
 * IT FINDS THE SCROLLPORT RATHER THAN BEING TOLD IT. The scroller is the shell's, several components above any
 * view that needs this, and threading a ref down through <SplitView> and a hub layout to reach it would make
 * every view in between carry a prop about somebody else's scrolling. Walking up from an element the caller
 * already has asks the same question of the DOM that `position: sticky` does, and gets the same answer.
 *
 * NOT `scrollIntoView`, and not `behavior: smooth`. This is not a journey the reader asked for: they changed
 * subject, and the top of the new one is where it starts. An animated 2000px flight through prose they did not
 * choose is motion for its own sake, and on a fresh render there is nothing at the destination yet to fly to. */

const scrollportOf = (start: HTMLElement): HTMLElement | undefined => {
    let el: HTMLElement | null = start.parentElement;
    while (el !== null) {
        const overflowY = getComputedStyle(el).overflowY;
        // `clip` and `hidden` are deliberately not scrollports here: `clip` is what <ScrollFrame> uses precisely
        // so it does NOT become one, and an `overflow-hidden` shell is a clamp, never a thing with a position.
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
 * @param element An element inside the scrollport: the view's own root is the usual one.
 * @param key What the scroll position is ABOUT. Changing it means the position no longer means anything.
 */
export function useScrollReset(element: Readonly<Ref<HTMLElement | undefined>>, key: () => unknown): void {
    watch(key, async () => {
        /* After the render that the new key causes, for the reason a short document exposes: the scrollport is
         * still the tall old document's height on the tick the key changes, and a browser asked to scroll a box
         * that is about to shrink clamps the request against the height it currently has. */
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
