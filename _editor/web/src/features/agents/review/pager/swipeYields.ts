// WHOSE SIDEWAYS FINGER IS IT. A page that swipes to its neighbour shares the screen with things that move sideways
// themselves: a code block or a table wider than the phone, a diff, an image compare's handle, the composer's caret, a
// selection being extended. Each of those keeps its own gesture, so the pager takes a horizontal touch only when nothing
// between where it started and the pager wants it. Asked once, when the touch has shown it is sideways, never per move.

/** Marks a subtree whose horizontal touches are its own (an open diff, a carousel): the pager never pages from inside it. */
export const OWN_SWIPE_ATTR = `data-own-swipe`;

// Typing surfaces and range controls: a sideways drag in them moves a caret or a value.
const TYPING = `input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="slider"], [${OWN_SWIPE_ATTR}]`;

// A `touch-action` that leaves horizontal panning out is an element that handles horizontal moves in script.
const claimsSideways = (touchAction: string): boolean =>
    touchAction !== `` && touchAction !== `auto` && touchAction !== `manipulation` && !touchAction.includes(`pan-x`);

// Wider than its box and allowed to scroll that way: the finger is there to scroll it. One pixel of slack, since a
// rounded subpixel width reads as an overflow of one.
const scrollsSideways = (el: HTMLElement, overflowX: string): boolean =>
    (overflowX === `auto` || overflowX === `scroll`) && el.scrollWidth > el.clientWidth + 1;

/** Whether a horizontal touch that started on `start` belongs to something inside `root` rather than to the pager on it. */
export const swipeBelongsElsewhere = (start: EventTarget | null, root: Element): boolean => {
    const selection = globalThis.document?.getSelection();
    // A selection being made or extended: its handles answer to the same finger.
    if (selection !== null && selection !== undefined && !selection.isCollapsed && selection.toString() !== ``) {
        return true;
    }
    for (let el = start instanceof Element ? start : null; el !== null && el !== root; el = el.parentElement) {
        if (!(el instanceof HTMLElement)) {
            continue;
        }
        if (el.matches(TYPING)) {
            return true;
        }
        const style = getComputedStyle(el);
        if (claimsSideways(style.touchAction) || scrollsSideways(el, style.overflowX)) {
            return true;
        }
    }
    return false;
};
