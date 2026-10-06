/* WHAT A PRESS ON THE PAGE DOES TO THE WINDOW. The desktop app's window has no frame (desktop-app windows.rs), and
   the page draws no title bar to stand in for one: the page itself is the handle. A press moves the window from
   the title band along the top edge and from any empty stretch of background below it, and leaves alone whatever
   the press was for first — a control, a line of text, a scrollbar, a resize seam, an overlay. */

/** What the window does about a press: `maximize` is the second click of a double-click in the title band. */
export type WindowGesture = "drag" | "maximize";

/* ANYTHING A PRESS IS FOR BEFORE IT IS FOR THE WINDOW: a control, a link, a field, a thing dragged or resized, a
   picture, another document, and whatever opts out with `data-window-no-drag`. `tabindex="-1"` is left out on
   purpose: it marks a container focused by script (the file tree, a scroller), not a control. */
const CONTROLS = [
    `a`,
    `button`,
    `input`,
    `select`,
    `textarea`,
    `label`,
    `summary`,
    `[contenteditable]`,
    `[draggable="true"]`,
    `[tabindex]:not([tabindex="-1"])`,
    `[role="button"]`,
    `[role="tab"]`,
    `[role="link"]`,
    `[role="menuitem"]`,
    `[role="menuitemcheckbox"]`,
    `[role="menuitemradio"]`,
    `[role="option"]`,
    `[role="treeitem"]`,
    `[role="row"]`,
    `[role="gridcell"]`,
    `[role="checkbox"]`,
    `[role="radio"]`,
    `[role="switch"]`,
    `[role="slider"]`,
    `[role="separator"]`,
    `[role="scrollbar"]`,
    `[role="combobox"]`,
    `[role="listbox"]`,
    `[role="textbox"]`,
    `[role="menu"]`,
    `[role="dialog"]`,
    `iframe`,
    `img`,
    `canvas`,
    `video`,
    `audio`,
    `object`,
    `embed`,
    `svg`,
    `[data-window-no-drag]`,
].join(`, `);

/* The cursors under which a press means nothing yet; every other cursor (pointer, text, grab, col-resize, …) names what the press is for. */
const IDLE_CURSORS = new Set([``, `auto`, `default`]);

/** The press itself, in viewport pixels. */
export interface Press {
    readonly target: EventTarget | null;
    readonly x: number;
    readonly y: number;
    /** How many clicks deep this press is (`MouseEvent.detail`). */
    readonly clicks: number;
    /** A modifier was held: shift extends a selection, and none of the others means "move the window". */
    readonly modified: boolean;
}

/** What the page knows about where a press landed: the DOM answers in the app (`domLayout`), a table answers in tests. */
export interface Layout {
    /** How far down the title band reaches, in viewport pixels: the height of the window's own buttons. */
    readonly band: number;
    /** The computed style an element is drawn with. */
    styleOf(element: Element): { readonly cursor: string; readonly userSelect: string; readonly position: string };
    /** Whether a point sits on an element's own scrollbar. */
    onScrollbar(element: Element, x: number, y: number): boolean;
    /** Whether a point sits on a line of text: where a press would anchor a selection. */
    onTextLine(x: number, y: number): boolean;
}

/* An overlay — a menu, a dialog and its mask, the notification lane, the window's own buttons — is fixed to the viewport; a press inside one is that overlay's. */
const inOverlay = (target: Element, layout: Layout): boolean => {
    for (let element: Element | null = target; element !== null && element !== document.body; element = element.parentElement) {
        if (layout.styleOf(element).position === `fixed`) {
            return true;
        }
    }
    return false;
};

/* Whether the press was for something on the page before it could be for the window. */
const claimed = (target: Element, x: number, y: number, layout: Layout): boolean =>
    target.closest(CONTROLS) !== null ||
    inOverlay(target, layout) ||
    !IDLE_CURSORS.has(layout.styleOf(target).cursor) ||
    layout.onScrollbar(target, x, y);

/* The band answers a press the way a title bar would, text included; the background below it yields to text. */
export const windowGesture = (press: Press, layout: Layout): WindowGesture | undefined => {
    const { target, x, y } = press;
    if (!(target instanceof Element) || press.modified || claimed(target, x, y, layout)) {
        return undefined;
    }
    if (y <= layout.band) {
        return press.clicks >= 2 ? `maximize` : `drag`;
    }
    return layout.styleOf(target).userSelect !== `none` && layout.onTextLine(x, y) ? undefined : `drag`;
};

/** A mouse event read as a press. `mousedown`, not `pointerdown`: a pointer event's `detail` is 0 by specification. */
export const pressOf = (event: MouseEvent): Press => ({
    target: event.target,
    x: event.clientX,
    y: event.clientY,
    clicks: event.detail,
    modified: event.shiftKey || event.ctrlKey || event.altKey || event.metaKey,
});

/* A scrollbar is the part of an element's box that its client area does not cover, on the right (LTR) and at the bottom. */
const onScrollbar = (element: Element, x: number, y: number): boolean => {
    const box = element.getBoundingClientRect();
    return x - box.left - element.clientLeft > element.clientWidth || y - box.top - element.clientTop > element.clientHeight;
};

/* The text node a press would anchor a selection in — the browser's own hit test, so it agrees with what a drag would select. */
const textAt = (x: number, y: number): Text | undefined => {
    const node =
        typeof document.caretPositionFromPoint === `function`
            ? document.caretPositionFromPoint(x, y)?.offsetNode
            : document.caretRangeFromPoint?.(x, y)?.startContainer;
    return node instanceof Text && node.data.trim() !== `` ? node : undefined;
};

/* A range's rects are glyph boxes; the line box around each is taller by the leading, half above and half below. */
const leadingOf = (text: Text, glyphHeight: number): number => {
    const lineHeight = text.parentElement === null ? Number.NaN : Number.parseFloat(getComputedStyle(text.parentElement).lineHeight);
    // `normal` parses to nothing: about a fifth of the glyph height on either side, the way a browser lays it.
    return Number.isFinite(lineHeight) ? Math.max(0, (lineHeight - glyphHeight) / 2) : glyphHeight * 0.2;
};

/* The point is ON a line of that text, not merely nearest to one: a press in the gap between paragraphs, or below the last one, is a press on the background. */
const onTextLine = (x: number, y: number): boolean => {
    const text = textAt(x, y);
    if (text === undefined) {
        return false;
    }
    const range = document.createRange();
    range.selectNodeContents(text);
    return [...range.getClientRects()].some((rect) => {
        const leading = leadingOf(text, rect.height);
        return rect.top - leading <= y && y <= rect.bottom + leading;
    });
};

/** The layout as the document answers it. */
export const domLayout = (band: number): Layout => ({
    band,
    styleOf: (element) => {
        const style = getComputedStyle(element);
        return { cursor: style.cursor, userSelect: style.userSelect, position: style.position };
    },
    onScrollbar,
    onTextLine,
});
