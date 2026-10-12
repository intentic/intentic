// Height is measured, not guessed. Order matters:
// - reset to `auto` first: a set height is a floor `scrollHeight` can't report under.
// - below one line's height means "not laid out yet" (detached, hidden); the one-row default stands.
// - border is added back manually, since `scrollHeight` excludes it.
// - an empty field is measured with its placeholder swapped in as the value, then reverted.
//
// Not for <ProseField>, which sizes itself with a CSS grid replica instead.

// The text each box was last sized for: text that only gained characters cannot need a shorter box. An empty box is
// sized for its placeholder, so that is what is kept for it: the first keystroke into a box a two-line placeholder grew
// is not an insertion into what was measured, and must shrink it back to one line.
const sizedFor = new WeakMap<HTMLTextAreaElement, string>();

/** Whether `next` is `previous` with characters inserted at one place and none removed. */
const onlyInserted = (previous: string, next: string): boolean => {
    if (next.length < previous.length) {
        return false;
    }
    let head = 0;
    while (head < previous.length && previous[head] === next[head]) {
        head++;
    }
    return next.endsWith(previous.slice(head));
};

export const growTextarea = (element: HTMLTextAreaElement | null | undefined, maxHeight?: number): void => {
    if (element === null || element === undefined) {
        return;
    }
    const throughPlaceholder = element.value === `` && element.placeholder !== ``;
    const text = throughPlaceholder ? element.placeholder : element.value;
    const previous = sizedFor.get(element);
    sizedFor.set(element, text);
    // Skipping the reset saves the layout it forces, once per keystroke; unchanged text (a resize) still resets, since
    // a wider box may need fewer lines.
    const grown = previous !== undefined && previous !== text && element.style.height !== `` && onlyInserted(previous, text);
    if (!grown) {
        element.style.height = `auto`;
    }
    const style = getComputedStyle(element);
    const oneLine = Number.parseFloat(style.lineHeight) + Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom);
    if (throughPlaceholder) {
        element.value = element.placeholder;
    }
    const measured = element.scrollHeight;
    if (throughPlaceholder) {
        element.value = ``;
    }
    if (measured <= 0 || measured < oneLine) {
        return;
    }
    const border = style.boxSizing === `border-box` ? Number.parseFloat(style.borderTopWidth) + Number.parseFloat(style.borderBottomWidth) : 0;
    const height = `${Math.min(measured + border, maxHeight ?? Number.POSITIVE_INFINITY)}px`;
    // An identical write still dirties style, and the next frame would lay the box out again for nothing.
    if (element.style.height !== height) {
        element.style.height = height;
    }
};
