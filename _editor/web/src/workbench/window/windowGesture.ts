/* WHAT A PRESS ON THE PAGE DOES TO THE WINDOW. The desktop app's window has no frame (desktop-app windows.rs), and
   the page draws no title bar to stand in for one: the page itself is the handle. A press moves the window from
   the title band along the top edge and from any empty stretch of background below it, and leaves alone whatever
   the press was for first — a control, text and the margin around it, a scrollbar, a resize seam, an overlay. */

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
    /** Whether a press on `target` at a point is within reach of a line of text someone could select from there. */
    nearText(target: Element, x: number, y: number): boolean;
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

/* The band answers a press the way a title bar would, text included; the background below it yields to text and to
   the margin around it, since that is where a selection is started from as often as from the words themselves. */
export const windowGesture = (press: Press, layout: Layout): WindowGesture | undefined => {
    const { target, x, y } = press;
    if (!(target instanceof Element) || press.modified || claimed(target, x, y, layout)) {
        return undefined;
    }
    if (y <= layout.band) {
        return press.clicks >= 2 ? `maximize` : `drag`;
    }
    return layout.styleOf(target).userSelect !== `none` && layout.nearText(target, x, y) ? undefined : `drag`;
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

/* --- Near a line of text ------------------------------------------------------------------------------------ */

/* HOW CLOSE "NEXT TO TEXT" IS. A selection is started from beside the words as often as from on them: the gap above a
   paragraph, a message bubble's padding, the margin before a line's first word, the empty end of a short line. So a
   press is the selection's when a line of selectable text lies within reach of it: a line's own height above and below,
   and twice that to either side, where the margin beside a column is where a selection of whole lines starts. Clamped,
   so an 11px caption still has a target and a heading's reach does not swallow the page. A press with text above it
   and below it, each within two reaches, is inside the run of the text, however wide the gap between two messages.
   Background farther than that from any text is the window's.

   Until 2026-11-13 only a press ON a line (inside its line box, as the browser's caret resolved it) was the text's, so
   every gap between paragraphs and messages and the padding of every bubble moved the window, while a press far out in
   a column's gutter at exactly a line's height selected: a zebra no reader could aim by. */
const REACH = { min: 16, max: 32, across: 2, bridge: 2 } as const;

/* WHERE THE BROWSER IS ASKED WHICH TEXT IS NEAR: the press and a ring around it out to the widest reach, and above and
   below it as far as a bridge spans (in reaches: across, down). The caret hit test (the one a selection anchors by)
   names the text at each point; the geometry below decides how near it is. A text the probes all miss is one too
   small to be in reach. */
const RING: readonly (readonly [number, number])[] = [
    [0, 0],
    [0, -0.5],
    [0, 0.5],
    [-0.5, 0],
    [0.5, 0],
    [0, -1],
    [0, 1],
    [-1, 0],
    [1, 0],
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
    [0, -REACH.bridge],
    [0, REACH.bridge],
];
const PROBES = RING.map(([across, down]) => [across * REACH.max * REACH.across, down * REACH.max] as const);

/* WORDS THAT NAME A CONTROL rather than read as content: a press beside a button's label is a press beside the button,
   and the empty stretch of a toolbar or a list stays the window's however many labels it holds. A link reads as prose. */
const LABELS = [
    `button`,
    `select`,
    `label`,
    `summary`,
    `[draggable="true"]`,
    `[role="button"]`,
    `[role="tab"]`,
    `[role="menuitem"]`,
    `[role="menuitemcheckbox"]`,
    `[role="menuitemradio"]`,
    `[role="option"]`,
    `[role="treeitem"]`,
    `[role="row"]`,
    `[role="checkbox"]`,
    `[role="radio"]`,
    `[role="switch"]`,
    `[role="slider"]`,
    `[role="combobox"]`,
].join(`, `);

/* The text node a press there would anchor a selection in — the browser's own hit test, so it agrees with what a drag would select. */
const textAt = (x: number, y: number): Text | undefined => {
    if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) {
        return undefined;
    }
    const node =
        typeof document.caretPositionFromPoint === `function`
            ? document.caretPositionFromPoint(x, y)?.offsetNode
            : document.caretRangeFromPoint?.(x, y)?.startContainer;
    return node instanceof Text && node.data.trim() !== `` ? node : undefined;
};

/* Text a reader could select here: not refused by `user-select`, not a control's label, not on an overlay floating over the press. */
const selectable = (text: Text, layout: Layout): boolean => {
    const holder = text.parentElement;
    return holder !== null && layout.styleOf(holder).userSelect !== `none` && holder.closest(LABELS) === null && !inOverlay(holder, layout);
};

interface Box {
    readonly left: number;
    readonly top: number;
    readonly right: number;
    readonly bottom: number;
}

/* A SCROLLER IS AN EDGE between what it holds and a press outside it, along each axis it actually scrolls on. */
const hidesFrom = (scroller: Element, box: DOMRect, clipsAcross: boolean, clipsDown: boolean, x: number, y: number): boolean =>
    (clipsDown && scroller.scrollHeight > scroller.clientHeight && (y < box.top || y > box.bottom)) ||
    (clipsAcross && scroller.scrollWidth > scroller.clientWidth && (x < box.left || x > box.right));

/* WHAT OF A TEXT IS ON SHOW TO THE PRESS: the part every box that clips it leaves visible, below the title band (whose
   words are a title's, pressed to move the window), and nothing at all when a scroller the press is outside of hides
   it from the press. The header above a scrolled transcript is not next to the line scrolled up under it; the gap
   above a code block that scrolls sideways is still next to its first line. */
const shownTo = (text: Text, target: Element, x: number, y: number, band: number): Box | undefined => {
    let shown: Box = { left: 0, top: band, right: window.innerWidth, bottom: window.innerHeight };
    for (let element = text.parentElement; element !== null; element = element.parentElement) {
        const style = getComputedStyle(element);
        const clipsAcross = style.overflowX !== `visible`;
        const clipsDown = style.overflowY !== `visible`;
        if (!clipsAcross && !clipsDown) {
            continue;
        }
        const box = element.getBoundingClientRect();
        if (!element.contains(target) && hidesFrom(element, box, clipsAcross, clipsDown, x, y)) {
            return undefined;
        }
        shown = {
            left: clipsAcross ? Math.max(shown.left, box.left) : shown.left,
            right: clipsAcross ? Math.min(shown.right, box.right) : shown.right,
            top: clipsDown ? Math.max(shown.top, box.top) : shown.top,
            bottom: clipsDown ? Math.min(shown.bottom, box.bottom) : shown.bottom,
        };
    }
    return shown.right > shown.left && shown.bottom > shown.top ? shown : undefined;
};

/* The box a line is laid in, across: the block it runs in, so the empty end of a short line is still on the line. A
   text that is an item of a flex or grid row on its own runs only as wide as its words, and the row beside it stays
   background. */
const acrossOf = (holder: Element): Box | undefined => {
    for (let element: Element | null = holder; element !== null; element = element.parentElement) {
        const display = getComputedStyle(element).display;
        if (display === `inline` || display === `contents`) {
            continue;
        }
        return display.includes(`flex`) || display.includes(`grid`) ? undefined : element.getBoundingClientRect();
    }
    return undefined;
};

/* A range's rects are glyph boxes; the line box around each is taller by the leading, half above and half below. */
const leadingOf = (holder: Element, glyphHeight: number): number => {
    const lineHeight = Number.parseFloat(getComputedStyle(holder).lineHeight);
    // `normal` parses to nothing: about a fifth of the glyph height on either side, the way a browser lays it.
    return Number.isFinite(lineHeight) ? Math.max(0, (lineHeight - glyphHeight) / 2) : glyphHeight * 0.2;
};

/** A line of text as much of it as the press can see, and how far its reach runs. */
interface Line extends Box {
    readonly reach: number;
}

/* The text's lines, each laid as wide as the block it runs in, as tall as its line box, and cut to what is on show. */
const linesOf = (text: Text, target: Element, x: number, y: number, band: number): Line[] => {
    const holder = text.parentElement;
    const shown = holder === null ? undefined : shownTo(text, target, x, y, band);
    if (holder === null || shown === undefined) {
        return [];
    }
    const across = acrossOf(holder);
    const range = document.createRange();
    range.selectNodeContents(text);
    return [...range.getClientRects()].flatMap((glyphs) => {
        const leading = leadingOf(holder, glyphs.height);
        const line = {
            left: Math.max(across?.left ?? glyphs.left, shown.left),
            right: Math.min(across?.right ?? glyphs.right, shown.right),
            top: Math.max(glyphs.top - leading, shown.top),
            bottom: Math.min(glyphs.bottom + leading, shown.bottom),
            reach: Math.min(REACH.max, Math.max(REACH.min, glyphs.height + 2 * leading)),
        };
        return glyphs.width > 0 && glyphs.height > 0 && line.right >= line.left && line.bottom >= line.top ? [line] : [];
    });
};

/* How far a press is from a line, in the line's reaches: to either side, and above it (negative) or below it (positive). */
const offsetFrom = (line: Line, x: number, y: number) => ({
    across: Math.max(line.left - x, 0, x - line.right) / (line.reach * REACH.across),
    down: (y < line.top ? y - line.top : Math.max(0, y - line.bottom)) / line.reach,
});

/* Within reach of one of the lines, or within a bridge of a line above the press and of one below it. */
const inReach = (lines: readonly Line[], x: number, y: number): boolean => {
    let above = false;
    let below = false;
    for (const line of lines) {
        const { across, down } = offsetFrom(line, x, y);
        if (Math.hypot(across, down) <= 1) {
            return true;
        }
        if (across <= 1 && Math.abs(down) <= REACH.bridge) {
            above ||= down > 0;
            below ||= down < 0;
        }
    }
    return above && below;
};

/* Within reach of a line of text a reader could select from here. */
const nearText = (target: Element, x: number, y: number, layout: Layout): boolean => {
    const texts = new Set<Text>();
    for (const [across, down] of PROBES) {
        const text = textAt(x + across, y + down);
        if (text !== undefined && selectable(text, layout)) {
            texts.add(text);
        }
    }
    return inReach(
        [...texts].flatMap((text) => linesOf(text, target, x, y, layout.band)),
        x,
        y,
    );
};

/** The layout as the document answers it. */
export const domLayout = (band: number): Layout => {
    const layout: Layout = {
        band,
        styleOf: (element) => {
            const style = getComputedStyle(element);
            return { cursor: style.cursor, userSelect: style.userSelect, position: style.position };
        },
        onScrollbar,
        nearText: (target, x, y) => nearText(target, x, y, layout),
    };
    return layout;
};
